package cors

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddleware(t *testing.T) {
	tests := []struct {
		name       string
		origins    []string
		method     string
		origin     string
		preflight  string
		wantStatus int
		wantOrigin string
		wantNext   bool
	}{
		{"first origin", []string{"https://a.example", "https://b.example"}, "GET", "https://a.example", "", 206, "https://a.example", true},
		{"second origin", []string{"https://a.example", "https://b.example"}, "HEAD", "https://b.example", "", 206, "https://b.example", true},
		{"unlisted origin", []string{"https://a.example"}, "GET", "https://evil.example", "", 206, "", true},
		{"no origin", []string{"https://a.example"}, "GET", "", "", 206, "", true},
		{"preflight get", []string{"https://a.example"}, "OPTIONS", "https://a.example", "GET", 204, "https://a.example", false},
		{"preflight head", []string{"https://a.example"}, "OPTIONS", "https://a.example", "HEAD", 204, "https://a.example", false},
		{"preflight bad method", []string{"https://a.example"}, "OPTIONS", "https://a.example", "POST", 405, "https://a.example", false},
		{"preflight denied", []string{"https://a.example"}, "OPTIONS", "https://evil.example", "GET", 403, "", false},
		{"wildcard", []string{"*"}, "GET", "https://any.example", "", 206, "*", true},
		{"unset retains behavior", nil, "OPTIONS", "https://a.example", "GET", 206, "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			nextCalled := false
			handler := Middleware(tc.origins, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				nextCalled = true
				w.Header().Set("Content-Range", "bytes 0-4/10")
				w.WriteHeader(http.StatusPartialContent)
			}))
			req := httptest.NewRequest(tc.method, "/stream/1/movie.mkv?hash=abc", nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.preflight != "" {
				req.Header.Set("Access-Control-Request-Method", tc.preflight)
				req.Header.Set("Access-Control-Request-Headers", "range")
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != tc.wantOrigin {
				t.Errorf("allow origin = %q, want %q", got, tc.wantOrigin)
			}
			if nextCalled != tc.wantNext {
				t.Errorf("next called = %t, want %t", nextCalled, tc.wantNext)
			}
			if tc.preflight == "GET" && tc.wantStatus == http.StatusNoContent {
				if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Range" {
					t.Errorf("allow headers = %q, want Range", got)
				}
				if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET, HEAD" {
					t.Errorf("allow methods = %q", got)
				}
			}
			if tc.origin != "" && len(tc.origins) > 0 && !strings.Contains(strings.Join(rec.Header().Values("Vary"), ","), "Origin") {
				t.Error("missing Vary: Origin")
			}
			if tc.wantOrigin != "" && tc.wantNext && !strings.Contains(rec.Header().Get("Access-Control-Expose-Headers"), "Content-Range") {
				t.Error("missing Content-Range exposure")
			}
		})
	}
}
