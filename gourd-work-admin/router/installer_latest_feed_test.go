package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestInstallerLatestFeedIsAnonymousAndBare locks down the contract the desktop
// updater depends on. The installed Rust app has no dashboard session, so:
//
//   1. GET /api/installer-latest.json must NOT be gated by UserAuth/AdminAuth;
//   2. the body must be the uploaded latest.json verbatim — tauri-plugin-updater
//      parses it directly, and the usual {success,message,data} envelope would
//      make every update check fail with an invalid release manifest.
//
// Both /api aliases and the static-style path are exercised, since any of them
// can be the GWORK_UPDATE_URL a deployment points at.
func TestInstallerLatestFeedIsAnonymousAndBare(t *testing.T) {
	gin.SetMode(gin.TestMode)

	dir := t.TempDir()
	t.Setenv("INSTALLER_STORAGE_DIR", dir)

	manifest := map[string]any{
		"version": "9.9.9",
		"notes":   "test release",
		"platforms": map[string]any{
			"windows-x86_64": map[string]any{
				"signature": "untrusted comment: test\nRWQf6LRCGA9i53tsomebase64payload==\n",
				"url":       "https://example.com/GWork_9.9.9_x64-setup.exe",
			},
		},
	}
	body, err := json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "latest.json"), body, 0644))

	engine := gin.New()
	require.NotPanics(t, func() { SetApiRouter(engine) })

	for _, path := range []string{
		"/api/installer-latest",
		"/api/installer-latest.json",
		"/downloads/tauri/latest.json",
	} {
		t.Run(path, func(t *testing.T) {
			// Deliberately no cookie, no Authorization header, no token.
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			engine.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code,
				"desktop client must read the feed without logging in")
			assert.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Contains(t, rec.Header().Get("Cache-Control"), "no-cache",
				"admin uploads must be visible on the next update check")
			assert.JSONEq(t, string(body), rec.Body.String(),
				"body must be the raw manifest bytes, not an ApiSuccess envelope")
			assert.NotContains(t, rec.Body.String(), `"success":`,
				"an ApiSuccess wrapper would break tauri-plugin-updater parsing")
		})
	}
}
