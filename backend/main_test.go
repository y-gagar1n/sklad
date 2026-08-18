package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func rec(id string, updatedAt float64, deleted bool, data string) Record {
	r := Record{ID: id, UpdatedAt: updatedAt, Deleted: deleted}
	if data != "" {
		r.Data = json.RawMessage(data)
	}
	return r
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "sklad-sync.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// ── apply (LWW) ─────────────────────────────────────────────────────────────

func TestApplyLWW(t *testing.T) {
	s := newTestStore(t)
	coll := s.state.Coll["items"]

	// Новая запись принимается.
	if n := s.apply(coll, []Record{rec("a", 100, false, `{"name":"Молоко"}`)}); n != 1 {
		t.Fatalf("ожидали 1 принятую, получили %d", n)
	}
	// Более старая — отвергается.
	if n := s.apply(coll, []Record{rec("a", 50, false, `{"name":"Старое"}`)}); n != 0 {
		t.Fatalf("старую запись не должны принимать, приняли %d", n)
	}
	// Равная метка — за инкумбентом (ничью не принимаем).
	if n := s.apply(coll, []Record{rec("a", 100, false, `{"name":"Ничья"}`)}); n != 0 {
		t.Fatalf("ничью не должны принимать, приняли %d", n)
	}
	// Более свежая — принимается.
	if n := s.apply(coll, []Record{rec("a", 200, false, `{"name":"Новое"}`)}); n != 1 {
		t.Fatalf("свежую должны принять")
	}
	if got := string(coll["a"].Data); got != `{"name":"Новое"}` {
		t.Fatalf("данные не обновились: %s", got)
	}
	// Пустой id игнорируется.
	if n := s.apply(coll, []Record{rec("", 300, false, `{}`)}); n != 0 {
		t.Fatalf("пустой id не должен приниматься")
	}
}

func TestApplyTombstoneClearsData(t *testing.T) {
	s := newTestStore(t)
	coll := s.state.Coll["items"]
	s.apply(coll, []Record{rec("a", 100, false, `{"name":"Молоко"}`)})
	s.apply(coll, []Record{rec("a", 200, true, `{"name":"должно исчезнуть"}`)})
	if coll["a"].Data != nil {
		t.Fatalf("у тумбстоуна data должна быть nil, получили %s", coll["a"].Data)
	}
	if !coll["a"].Deleted {
		t.Fatalf("запись должна быть помечена deleted")
	}
}

// ── changedSince ────────────────────────────────────────────────────────────

func TestChangedSinceOrderAndCursor(t *testing.T) {
	s := newTestStore(t)
	coll := s.state.Coll["items"]
	s.apply(coll, []Record{rec("a", 10, false, `{}`)}) // seq 1
	s.apply(coll, []Record{rec("b", 20, false, `{}`)}) // seq 2
	s.apply(coll, []Record{rec("c", 30, false, `{}`)}) // seq 3

	all := changedSince(coll, 0)
	if len(all) != 3 {
		t.Fatalf("ожидали 3, получили %d", len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].Seq >= all[i].Seq {
			t.Fatalf("должно быть отсортировано по возрастанию seq")
		}
	}
	// since=2 отдаёт только seq>2.
	delta := changedSince(coll, 2)
	if len(delta) != 1 || delta[0].ID != "c" {
		t.Fatalf("since=2 должен отдать только c, получили %+v", delta)
	}
}

// ── HTTP /sync ──────────────────────────────────────────────────────────────

func doSync(t *testing.T, h http.Handler, token string, body map[string]any) map[string]json.RawMessage {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(b))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("sync вернул %d: %s", w.Code, w.Body.String())
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("не разобрали ответ: %v", err)
	}
	return out
}

func TestSyncPushPullCursor(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")

	// Пуш двух товаров.
	resp := doSync(t, h, "secret", map[string]any{
		"since": 0,
		"items": []Record{rec("a", 100, false, `{"n":1}`), rec("b", 100, false, `{"n":2}`)},
	})
	var seq int64
	json.Unmarshal(resp["seq"], &seq)
	if seq != 2 {
		t.Fatalf("ожидали seq=2, получили %d", seq)
	}
	var items []Record
	json.Unmarshal(resp["items"], &items)
	if len(items) != 2 {
		t.Fatalf("свой пуш должен вернуться эхом, получили %d", len(items))
	}
	// Пустые коллекции — [] а не null.
	if string(resp["categories"]) != "[]" {
		t.Fatalf("пустая коллекция должна быть [], получили %s", resp["categories"])
	}

	// Второй клиент с курсором seq видит 0 новых.
	resp2 := doSync(t, h, "secret", map[string]any{"since": seq})
	var items2 []Record
	json.Unmarshal(resp2["items"], &items2)
	if len(items2) != 0 {
		t.Fatalf("с актуальным курсором новых быть не должно, получили %d", len(items2))
	}

	// Курсор больше серверного seq → отдать всё с нуля.
	resp3 := doSync(t, h, "secret", map[string]any{"since": int64(999)})
	var items3 []Record
	json.Unmarshal(resp3["items"], &items3)
	if len(items3) != 2 {
		t.Fatalf("since>seq должен отдать всё с нуля, получили %d", len(items3))
	}
}

func TestSyncMultipleCollections(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	resp := doSync(t, h, "secret", map[string]any{
		"since":      0,
		"categories": []Record{rec("c1", 10, false, `{"name":"Молоко"}`)},
		"items":      []Record{rec("i1", 10, false, `{"name":"Коровье"}`)},
		"floors":     []Record{rec("f1", 10, false, `{"name":"Этаж 1"}`)},
		"movements":  []Record{rec("m1", 10, false, `{"qty":5}`)},
		"settings":   []Record{rec("s1", 10, false, `{"windowDays":30}`)},
	})
	for _, name := range collectionNames {
		var recs []Record
		json.Unmarshal(resp[name], &recs)
		if len(recs) != 1 {
			t.Fatalf("коллекция %s должна вернуть 1 запись, получили %d", name, len(recs))
		}
	}
}

// ── /wipe ───────────────────────────────────────────────────────────────────

func TestWipeTombstonesAll(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	doSync(t, h, "secret", map[string]any{
		"since": 0,
		"items": []Record{rec("a", 100, false, `{"n":1}`)},
	})

	req := httptest.NewRequest(http.MethodPost, "/wipe", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("wipe вернул %d", w.Code)
	}
	if !s.state.Coll["items"]["a"].Deleted {
		t.Fatalf("после wipe запись должна стать тумбстоуном")
	}
	// updatedAt тумбстоуна должен превышать прежний (max(now, existing+1)).
	if s.state.Coll["items"]["a"].UpdatedAt <= 100 {
		t.Fatalf("updatedAt тумбстоуна должен вырасти")
	}
}

// ── авторизация ─────────────────────────────────────────────────────────────

func TestRequireToken(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	cases := []struct {
		name, header string
		want         int
	}{
		{"нет заголовка", "", http.StatusUnauthorized},
		{"неверный токен", "Bearer wrong", http.StatusUnauthorized},
		{"верный токен", "Bearer secret", http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader([]byte(`{"since":0}`)))
			if c.header != "" {
				req.Header.Set("Authorization", c.header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != c.want {
				t.Fatalf("ожидали %d, получили %d", c.want, w.Code)
			}
		})
	}
}

func TestHealthOpen(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("health должен быть открыт, получили %d", w.Code)
	}
}

func TestSyncRejectsGet(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	req := httptest.NewRequest(http.MethodGet, "/sync", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /sync должен быть 405, получили %d", w.Code)
	}
}

// ── CORS ─────────────────────────────────────────────────────────────────────

func TestCORS(t *testing.T) {
	pages := "https://y-gagar1n.github.io"
	cases := []struct {
		name       string
		allowed    map[string]bool
		method     string
		origin     string
		wantStatus int
		wantACAO   string // ожидаемый Access-Control-Allow-Origin ("" — заголовка нет)
	}{
		{"preflight-any", nil, http.MethodOptions, pages, http.StatusNoContent, "*"},
		{"preflight-allowed", parseOrigins(pages), http.MethodOptions, pages, http.StatusNoContent, pages},
		{"preflight-denied", parseOrigins(pages), http.MethodOptions, "https://evil.example", http.StatusNoContent, ""},
		{"actual-any", nil, http.MethodGet, pages, http.StatusOK, "*"},
		{"actual-allowed", parseOrigins(pages), http.MethodGet, pages, http.StatusOK, pages},
		{"actual-denied", parseOrigins(pages), http.MethodGet, "https://evil.example", http.StatusOK, ""},
		{"no-origin", nil, http.MethodGet, "", http.StatusOK, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStore(t)
			h := withCORS(tc.allowed, newMux(s, "secret", ""))
			req := httptest.NewRequest(tc.method, "/health", nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("статус: ждали %d, получили %d", tc.wantStatus, w.Code)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != tc.wantACAO {
				t.Fatalf("ACAO: ждали %q, получили %q", tc.wantACAO, got)
			}
			if tc.method == http.MethodOptions {
				if h := w.Header().Get("Access-Control-Allow-Headers"); h == "" {
					t.Fatalf("preflight без Access-Control-Allow-Headers")
				}
			}
		})
	}
}

func TestParseOrigins(t *testing.T) {
	if parseOrigins("") != nil || parseOrigins("*") != nil || parseOrigins(" , * ") != nil {
		t.Fatalf("пусто/звёздочка должны давать nil (любой origin)")
	}
	set := parseOrigins("https://a.example, https://b.example ")
	if !set["https://a.example"] || !set["https://b.example"] || len(set) != 2 {
		t.Fatalf("неверный разбор списка: %#v", set)
	}
}

// ── персистентность ─────────────────────────────────────────────────────────

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sklad-sync.json")
	s1, _ := NewStore(path)
	h := newMux(s1, "secret", "")
	doSync(t, h, "secret", map[string]any{
		"since": 0,
		"items": []Record{rec("a", 100, false, `{"n":1}`)},
	})
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("файл данных не создан: %v", err)
	}
	// Перечитываем с диска.
	s2, err := NewStore(path)
	if err != nil {
		t.Fatalf("повторное чтение: %v", err)
	}
	if s2.state.Coll["items"]["a"] == nil {
		t.Fatalf("запись не сохранилась на диск")
	}
	if s2.state.Seq != 1 {
		t.Fatalf("seq не восстановился, получили %d", s2.state.Seq)
	}
}

// ── гонки ───────────────────────────────────────────────────────────────────

func TestConcurrentSync(t *testing.T) {
	s := newTestStore(t)
	h := newMux(s, "secret", "")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b, _ := json.Marshal(map[string]any{
				"since": 0,
				"items": []Record{rec(fmt.Sprintf("i%d", i), float64(100+i), false, `{}`)},
			})
			req := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(b))
			req.Header.Set("Authorization", "Bearer secret")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("sync вернул %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	if len(s.state.Coll["items"]) != 20 {
		t.Fatalf("ожидали 20 записей, получили %d", len(s.state.Coll["items"]))
	}
	if s.state.Seq != 20 {
		t.Fatalf("seq должен быть 20, получили %d", s.state.Seq)
	}
}
