// sklad-sync — сервер синхронизации и раздачи веб-приложения «Склад».
//
// Один бинарь делает две вещи:
//   1. Отдаёт статику приложения (index.html, assets/*, icons/*, sw.js, manifest)
//      с флага -static — если фронт живёт на том же origin.
//   2. Держит API синхронизации данных между устройствами.
//
// Деплой: автоматически по пушу в backend/** (воркфлоу
// .github/workflows/deploy-backend.yml) либо вручную ./deploy-sklad.sh.
//
// Фронт может лежать и на другом origin (например, GitHub Pages
// https://y-gagar1n.github.io/sklad/) — тогда браузеру нужен CORS. Разрешённые
// origin'ы задаются флагом -cors-origin (или env SKLAD_CORS_ORIGIN, через
// запятую); пусто — разрешить любой ("*"). Авторизация всё равно по bearer-токену
// в заголовке (не cookie), поэтому "*" безопасен: без токена запрос не пройдёт.
//
// Протокол: POST /sync
//   запрос: { "since": <seq>, "categories":[Record], "items":[Record],
//             "floors":[Record], "movements":[Record], "settings":[Record] }
//   ответ:  { "seq": <seq>, ...те же коллекции... }
//
// Record: { "id": string, "updatedAt": <ms>, "deleted": bool, "data": {...} }.
// Конфликты — last-write-wins по updatedAt, удаления — тумбстоуны. Клиент хранит
// seq из ответа и шлёт его как since дальше. POST /wipe тумбстоунит всё.
//
// Защита и многотенантность: /sync и /wipe требуют Authorization: Bearer <токен>.
// Токен отображается на стабильную метку тенанта (tenantId) через -tokens-file
// (строки "tenantId: token"); у каждого тенанта свой файл данных <data-dir>/<id>.json
// и свой seq — токен A не видит данные токена B. Токен — лишь ключ к метке, поэтому
// его ротация не теряет склад. Fallback: если файла нет, но задан env
// SKLAD_SYNC_TOKEN — единственный тенант "default" (прежнее поведение). /health открыт.
//
// TLS: если задан -acme-domain (или env SKLAD_ACME_DOMAIN) — сервер сам получает
// и продлевает валидный сертификат Let's Encrypt (TLS-ALPN-01 на :443), домена
// покупать не надо (годится 213-165-212-180.sslip.io). Иначе -tls-cert/-tls-key,
// иначе (для localhost-разработки) — обычный HTTP.
//
// ВАЖНО: сервис полностью изолирован от todo-sync — свои пути, порт, данные.
package main

import (
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

// Порядок коллекций фиксирован — по нему ходим в apply/changedSince.
var collectionNames = []string{"categories", "items", "floors", "movements", "settings"}

type Record struct {
	ID        string          `json:"id"`
	UpdatedAt float64         `json:"updatedAt"`
	Deleted   bool            `json:"deleted"`
	Data      json.RawMessage `json:"data,omitempty"`
	Seq       int64           `json:"seq,omitempty"`
}

type State struct {
	Seq  int64                         `json:"seq"`
	Coll map[string]map[string]*Record `json:"collections"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	state State
}

func newState() State {
	st := State{Coll: map[string]map[string]*Record{}}
	for _, name := range collectionNames {
		st.Coll[name] = map[string]*Record{}
	}
	return st
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path, state: newState()}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.state); err != nil {
		return nil, fmt.Errorf("повреждён файл данных %s: %w", path, err)
	}
	if s.state.Coll == nil {
		s.state.Coll = map[string]map[string]*Record{}
	}
	for _, name := range collectionNames {
		if s.state.Coll[name] == nil {
			s.state.Coll[name] = map[string]*Record{}
		}
	}
	return s, nil
}

func (s *Store) save() error {
	raw, err := json.MarshalIndent(&s.state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// StoreManager держит по одному *Store на тенанта (метку) и лениво поднимает их из
// файлов <dir>/<tenantId>.json. Имя файла — по стабильному tenantId, не по токену,
// поэтому ротация токена не теряет данные. Каждый *Store хранит свой mu — тенанты
// не блокируют друг друга; общий mu защищает только карту сторов.
type StoreManager struct {
	mu     sync.Mutex
	dir    string
	stores map[string]*Store
}

func NewStoreManager(dir string) (*StoreManager, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &StoreManager{dir: dir, stores: map[string]*Store{}}, nil
}

// get возвращает (создавая при первом обращении) стор тенанта. tenantId уже
// провалидирован при загрузке токенов, поэтому в имя файла попадает безопасным.
func (m *StoreManager) get(tenantID string) (*Store, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.stores[tenantID]; ok {
		return s, nil
	}
	s, err := NewStore(filepath.Join(m.dir, tenantID+".json"))
	if err != nil {
		return nil, err
	}
	m.stores[tenantID] = s
	return s, nil
}

// apply вливает записи клиента в коллекцию по правилу LWW, возвращает число
// принятых. Ничья по updatedAt — за инкумбентом.
func (s *Store) apply(coll map[string]*Record, incoming []Record) int {
	accepted := 0
	for i := range incoming {
		rec := incoming[i]
		if rec.ID == "" {
			continue
		}
		existing, ok := coll[rec.ID]
		if ok && rec.UpdatedAt <= existing.UpdatedAt {
			continue
		}
		if rec.Deleted {
			rec.Data = nil
		}
		s.state.Seq++
		rec.Seq = s.state.Seq
		coll[rec.ID] = &rec
		accepted++
	}
	return accepted
}

func changedSince(coll map[string]*Record, since int64) []Record {
	var out []Record
	for _, rec := range coll {
		if rec.Seq > since {
			out = append(out, *rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

type syncRequest struct {
	Since       int64               `json:"since"`
	Collections map[string][]Record `json:"-"`
}

// Плоский JSON: {since, categories:[], items:[], ...}. Разбираем вручную, чтобы
// коллекции лежали на верхнем уровне, а не во вложенном объекте.
func (r *syncRequest) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if v, ok := raw["since"]; ok {
		if err := json.Unmarshal(v, &r.Since); err != nil {
			return err
		}
	}
	r.Collections = map[string][]Record{}
	for _, name := range collectionNames {
		if v, ok := raw[name]; ok {
			var recs []Record
			if err := json.Unmarshal(v, &recs); err != nil {
				return err
			}
			r.Collections[name] = recs
		}
	}
	return nil
}

func writeSyncResponse(w http.ResponseWriter, seq int64, per map[string][]Record) error {
	out := map[string]any{"seq": seq}
	for _, name := range collectionNames {
		recs := per[name]
		if recs == nil {
			recs = []Record{}
		}
		out[name] = recs
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(out)
}

func (s *Store) handleSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req syncRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Курсор от другой инкарнации сервера (файл пересоздан) — отдаём всё с нуля.
	if req.Since > s.state.Seq {
		req.Since = 0
	}

	accepted := 0
	for _, name := range collectionNames {
		accepted += s.apply(s.state.Coll[name], req.Collections[name])
	}
	if accepted > 0 {
		if err := s.save(); err != nil {
			log.Printf("ошибка записи %s: %v", s.path, err)
			http.Error(w, "storage error", http.StatusInternalServerError)
			return
		}
	}

	per := map[string][]Record{}
	for _, name := range collectionNames {
		per[name] = changedSince(s.state.Coll[name], req.Since)
	}

	log.Printf("sync %s: since=%d accepted=%d seq=%d", r.RemoteAddr, req.Since, accepted, s.state.Seq)
	if err := writeSyncResponse(w, s.state.Seq, per); err != nil {
		log.Printf("ошибка ответа: %v", err)
	}
}

// handleWipe тумбстоунит все записи; updatedAt = max(now, existing+1), чтобы
// тумбстоун побеждал по LWW даже при свежих pending-правках клиента.
func (s *Store) handleWipe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	nowMs := float64(time.Now().UnixMilli())
	counts := map[string]int{}
	total := 0
	for _, name := range collectionNames {
		coll := s.state.Coll[name]
		n := 0
		for id, rec := range coll {
			ts := nowMs
			if rec.UpdatedAt+1 > ts {
				ts = rec.UpdatedAt + 1
			}
			s.state.Seq++
			coll[id] = &Record{ID: rec.ID, UpdatedAt: ts, Deleted: true, Seq: s.state.Seq}
			n++
		}
		counts[name] = n
		total += n
	}
	if total > 0 {
		if err := s.save(); err != nil {
			log.Printf("ошибка записи %s: %v", s.path, err)
			http.Error(w, "storage error", http.StatusInternalServerError)
			return
		}
	}
	log.Printf("wipe %s: tombstoned=%d seq=%d", r.RemoteAddr, total, s.state.Seq)
	out := map[string]any{"seq": s.state.Seq}
	for name, n := range counts {
		out[name] = n
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// requireTenant резолвит bearer-токен в тенанта и передаёт его *Store хендлеру.
// Токен сверяется со всеми известными в constant-time и без раннего выхода, чтобы
// не раскрывать по таймингу, какой именно токен совпал.
func requireTenant(tokenToTenant map[string]string, m *StoreManager,
	next func(*Store, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	type entry struct {
		header []byte
		tenant string
	}
	entries := make([]entry, 0, len(tokenToTenant))
	for tok, tenant := range tokenToTenant {
		entries = append(entries, entry{[]byte("Bearer " + tok), tenant})
	}
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("Authorization"))
		tenant := ""
		for _, e := range entries {
			if len(got) == len(e.header) && subtle.ConstantTimeCompare(got, e.header) == 1 {
				tenant = e.tenant
			}
		}
		if tenant == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="sklad-sync"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		store, err := m.get(tenant)
		if err != nil {
			log.Printf("не удалось открыть стор тенанта %s: %v", tenant, err)
			http.Error(w, "storage error", http.StatusInternalServerError)
			return
		}
		next(store, w, r)
	}
}

// validTenantID: метка тенанта = имя файла на диске, поэтому ограничиваем
// безопасным набором [a-z0-9_-].
func validTenantID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// parseTokensFile читает строки "tenantId: token" (# — комментарий, пустые строки
// пропускаются) в карту token→tenantId. Дубли токенов и кривые метки — ошибка.
func parseTokensFile(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for i, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			return nil, fmt.Errorf("tokens-файл %s: строка %d без ':'", path, i+1)
		}
		tenant := strings.TrimSpace(line[:idx])
		token := strings.TrimSpace(line[idx+1:])
		if !validTenantID(tenant) {
			return nil, fmt.Errorf("tokens-файл %s: недопустимый tenantId %q (нужно [a-z0-9_-], до 64)", path, tenant)
		}
		if token == "" {
			return nil, fmt.Errorf("tokens-файл %s: пустой токен у %q", path, tenant)
		}
		if _, dup := out[token]; dup {
			return nil, fmt.Errorf("tokens-файл %s: токен повторяется", path)
		}
		out[token] = tenant
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("tokens-файл %s пуст — нет ни одного токена", path)
	}
	return out, nil
}

// loadTokens берёт соответствия token→tenantId из -tokens-file; если файла нет,
// откатывается на одиночный env SKLAD_SYNC_TOKEN (тенант "default").
func loadTokens(path string) (map[string]string, error) {
	if path != "" {
		if _, err := os.Stat(path); err == nil {
			return parseTokensFile(path)
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if tok := os.Getenv("SKLAD_SYNC_TOKEN"); tok != "" {
		return map[string]string{tok: "default"}, nil
	}
	return nil, fmt.Errorf("нет токенов: задай -tokens-file %q или env SKLAD_SYNC_TOKEN", path)
}

// staticHandler отдаёт файлы веб-приложения из каталога dir. Заодно чиним MIME
// для .webmanifest и .js (иначе часть окружений отдаёт octet-stream).
func staticHandler(dir string) http.Handler {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".js", "text/javascript")
	_ = mime.AddExtensionType(".mjs", "text/javascript")
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Service worker и офлайн-первый апп: без агрессивного кэша прокси.
		w.Header().Set("Cache-Control", "no-cache")
		fs.ServeHTTP(w, r)
	})
}

// parseOrigins разбирает список origin'ов через запятую. Пусто или "*" → nil,
// что означает «разрешить любой origin».
func parseOrigins(s string) map[string]bool {
	set := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		o := strings.TrimSpace(part)
		if o == "" || o == "*" {
			continue
		}
		set[o] = true
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

// withCORS добавляет CORS-заголовки и отвечает на preflight (OPTIONS). allowed ==
// nil → разрешаем любой origin ("*"); иначе отражаем Origin, только если он в
// списке. Preflight обрабатывается до роутинга, поэтому не упирается в bearer-токен
// (у preflight-запроса заголовка Authorization нет).
func withCORS(allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if allowed == nil {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else if allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newMux(m *StoreManager, tokenToTenant map[string]string, staticDir string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/sync", requireTenant(tokenToTenant, m, (*Store).handleSync))
	mux.HandleFunc("/wipe", requireTenant(tokenToTenant, m, (*Store).handleWipe))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	if staticDir != "" {
		mux.Handle("/", staticHandler(staticDir))
	}
	return mux
}

func main() {
	addr := flag.String("addr", ":443", "адрес прослушивания")
	dataDir := flag.String("data-dir", "data", "каталог файлов данных (по одному на тенанта: <id>.json)")
	tokensFile := flag.String("tokens-file", "/etc/sklad-sync/tokens", "файл соответствий 'tenantId: token' (иначе env SKLAD_SYNC_TOKEN — один тенант default)")
	staticDir := flag.String("static", "", "каталог со статикой веб-приложения (пусто — не раздавать)")
	acmeDomain := flag.String("acme-domain", "", "домен для авто-сертификата Let's Encrypt (иначе env SKLAD_ACME_DOMAIN)")
	acmeCache := flag.String("acme-cache", "/var/lib/sklad-sync/acme", "каталог кэша сертификатов ACME")
	tlsCert := flag.String("tls-cert", "", "путь к TLS-сертификату (PEM)")
	tlsKey := flag.String("tls-key", "", "путь к приватному ключу TLS (PEM)")
	corsOrigin := flag.String("cors-origin", "", "разрешённые CORS origin'ы через запятую (иначе env SKLAD_CORS_ORIGIN; пусто — любой)")
	flag.Parse()

	tokenToTenant, err := loadTokens(*tokensFile)
	if err != nil {
		log.Fatal(err)
	}
	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatal("--tls-cert и --tls-key нужно задавать вместе")
	}
	domain := *acmeDomain
	if domain == "" {
		domain = os.Getenv("SKLAD_ACME_DOMAIN")
	}
	corsRaw := *corsOrigin
	if corsRaw == "" {
		corsRaw = os.Getenv("SKLAD_CORS_ORIGIN")
	}
	allowedOrigins := parseOrigins(corsRaw)

	absDir, err := filepath.Abs(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	mgr, err := NewStoreManager(absDir)
	if err != nil {
		log.Fatal(err)
	}
	handler := withCORS(allowedOrigins, newMux(mgr, tokenToTenant, *staticDir))

	// 1) ACME/Let's Encrypt — валидный сертификат сам, TLS-ALPN-01 на :443.
	if domain != "" {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(domain),
			Cache:      autocert.DirCache(*acmeCache),
		}
		srv := &http.Server{Addr: ":443", Handler: handler, TLSConfig: m.TLSConfig()}
		log.Printf("sklad-sync: https://%s (Let's Encrypt), данные: %s, токенов: %d, статика: %q", domain, absDir, len(tokenToTenant), *staticDir)
		log.Fatal(srv.ListenAndServeTLS("", ""))
	}
	// 2) Заданный сертификат.
	if *tlsCert != "" {
		log.Printf("sklad-sync слушает https://%s, данные: %s, токенов: %d", *addr, absDir, len(tokenToTenant))
		log.Fatal(http.ListenAndServeTLS(*addr, *tlsCert, *tlsKey, handler))
	}
	// 3) Обычный HTTP — только для localhost-разработки (secure-context на localhost ок).
	log.Printf("sklad-sync слушает http://%s (без TLS!), данные: %s, токенов: %d", *addr, absDir, len(tokenToTenant))
	log.Fatal(http.ListenAndServe(*addr, handler))
}
