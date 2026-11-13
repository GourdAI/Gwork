package controller

import (
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The shape the desktop updater expects. Kept as a literal here so a change to
// the backend struct cannot silently accept a document the client cannot read.
const sampleLatestManifest = `{
  "version": "1.2.3",
  "notes": "bug fixes",
  "pub_date": "2026-01-02T03:04:05Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "untrusted comment: minisign signature\nRUB/aBc==",
      "url": "https://example.com/GWork_1.2.3_x64-setup.exe"
    },
    "darwin-aarch64": {
      "signature": "untrusted comment: minisign signature\nRUQ/xYz==",
      "url": "https://example.com/GWork_1.2.3_aarch64.app.tar.gz"
    }
  }
}`

func TestValidateInstallerLatest(t *testing.T) {
	t.Run("accepts a real tauri release manifest", func(t *testing.T) {
		doc, err := validateInstallerLatest([]byte(sampleLatestManifest))
		require.NoError(t, err)
		assert.Equal(t, "1.2.3", doc.Version)
		assert.Equal(t, "bug fixes", doc.Notes)
		assert.Len(t, doc.Platforms, 2)
	})

	// tauri-plugin-updater's ReleaseManifestPlatform.signature is a required
	// String (not Option<String>, no serde default): a signature-less entry
	// makes the WHOLE manifest fail deserialization, so updater.check() never
	// reaches version comparison. The admin must reject such a file up front.
	t.Run("rejects a platform without signature", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{
          "version": "1.2.3",
          "platforms": {
            "linux-x86_64": {"url": "https://example.com/a.AppImage"},
            "windows-x86_64": {"url": "https://example.com/a.exe", "signature": "sig"}
          }
        }`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no signature")
	})

	t.Run("rejects malformed JSON", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{not json`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Invalid latest.json manifest")
	})

	t.Run("rejects missing version", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{"platforms":{"windows-x86_64":{"url":"https://a","signature":"sig"}}}`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing version")
	})

	t.Run("rejects downloads.json (wrong artifact)", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{"version":"1.2.3","files":[{"name":"a.exe","os":"windows"}]}`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing platforms")
	})

	t.Run("rejects empty platforms map", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{"version":"1.2.3","platforms":{}}`))
		require.Error(t, err)
	})

	t.Run("rejects a platform entry without url", func(t *testing.T) {
		_, err := validateInstallerLatest([]byte(`{"version":"1.2.3","platforms":{"windows-x86_64":{"signature":"sig"}}}`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no url")
	})
}

func TestReadInstallerLatestInfo(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("INSTALLER_STORAGE_DIR", dir)
	require.NoError(t, os.WriteFile(installerLatestFilePath(), []byte(sampleLatestManifest), 0644))

	body, info, err := readInstallerLatest()
	require.NoError(t, err)
	assert.Equal(t, sampleLatestManifest, string(body), "public feed must return the uploaded bytes verbatim")
	require.NotNil(t, info)
	assert.Equal(t, "1.2.3", info.Version)
	assert.Equal(t, []string{"darwin-aarch64", "windows-x86_64"}, info.Platforms)
	assert.Equal(t, int64(len(sampleLatestManifest)), info.Size)
	assert.Equal(t, "/downloads/tauri/latest.json", info.URL)
	assert.Equal(t, "/api/installer-latest", info.ApiURL)
	assert.NotEmpty(t, info.UpdatedAt)
}

// The public handler must NOT wrap the manifest in {success,message,data}:
// tauri-plugin-updater parses the response body directly as the release JSON.
func TestGetInstallerLatestServesBareJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	t.Setenv("INSTALLER_STORAGE_DIR", dir)
	require.NoError(t, os.WriteFile(installerLatestFilePath(), []byte(sampleLatestManifest), 0644))

	r := gin.New()
	r.GET("/downloads/tauri/latest.json", GetInstallerLatest)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/downloads/tauri/latest.json", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, sampleLatestManifest, w.Body.String())
	assert.Contains(t, w.Header().Get("Content-Type"), "application/json")
	assert.Contains(t, w.Header().Get("Cache-Control"), "no-cache")

	var doc map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &doc))
	assert.NotContains(t, doc, "success", "ApiSuccess envelope would break the updater")
	assert.Equal(t, "1.2.3", doc["version"])
	assert.Contains(t, doc, "platforms")
}

func TestGetInstallerLatestMissingFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("INSTALLER_STORAGE_DIR", t.TempDir())

	r := gin.New()
	r.GET("/api/installer-latest", GetInstallerLatest)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/installer-latest", nil))

	// A non-2xx status is how tauri-plugin-updater recognises "no update".
	// A 200 carrying a {success:false} envelope would instead be deserialized
	// as a release manifest and surface a misleading parse error.
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Empty(t, w.Body.String(), "the body must not look like a release manifest")
}

func TestGetInstallerLatestInfoMissingFileIsNull(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("INSTALLER_STORAGE_DIR", t.TempDir())

	r := gin.New()
	r.GET("/api/installers/latest", GetInstallerLatestInfo)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/installers/latest", nil))

	var resp map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, true, resp["success"])
	assert.Nil(t, resp["data"], "no upload yet is a normal state, not an error")
}

// End-to-end for the admin upload: multipart in, atomic file on disk, bare JSON
// out of the public endpoint, and a second upload replaces it cleanly.
func TestUploadInstallerLatestRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	t.Setenv("INSTALLER_STORAGE_DIR", dir)

	r := gin.New()
	r.POST("/api/installers/latest", UploadInstallerLatest)
	r.GET("/downloads/tauri/latest.json", GetInstallerLatest)

	var body strings.Builder
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "latest.json")
	require.NoError(t, err)
	_, err = part.Write([]byte(sampleLatestManifest))
	require.NoError(t, err)
	require.NoError(t, mw.Close())

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/installers/latest", strings.NewReader(body.String()))
	req.Header.Set("Content-Type", mw.FormDataContentType())
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var uploadResp map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &uploadResp))
	assert.Equal(t, true, uploadResp["success"])
	data := uploadResp["data"].(map[string]any)
	assert.Equal(t, "/downloads/tauri/latest.json", data["url"])

	// Exactly one file, no leftover .tmp, and the bytes are the original ones.
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "latest.json", entries[0].Name())
	onDisk, err := os.ReadFile(filepath.Join(dir, "latest.json"))
	require.NoError(t, err)
	assert.Equal(t, sampleLatestManifest, string(onDisk))

	public := httptest.NewRecorder()
	r.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/downloads/tauri/latest.json", nil))
	assert.Equal(t, sampleLatestManifest, public.Body.String())

	// A second upload must replace the first cleanly and leave no .tmp behind.
	// This also guards the unique-temp-name fix: two uploads used to share
	// "latest.json.tmp" and could truncate each other.
	var body2 strings.Builder
	mw2 := multipart.NewWriter(&body2)
	part2, err := mw2.CreateFormFile("file", "latest.json")
	require.NoError(t, err)
	_, err = part2.Write([]byte(strings.Replace(sampleLatestManifest, "1.2.3", "9.9.9", 1)))
	require.NoError(t, err)
	require.NoError(t, mw2.Close())
	req2 := httptest.NewRequest(http.MethodPost, "/api/installers/latest", strings.NewReader(body2.String()))
	req2.Header.Set("Content-Type", mw2.FormDataContentType())
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusOK, w2.Code, w2.Body.String())

	public2 := httptest.NewRecorder()
	r.ServeHTTP(public2, httptest.NewRequest(http.MethodGet, "/downloads/tauri/latest.json", nil))
	assert.Contains(t, public2.Body.String(), `"version": "9.9.9"`)
	onDisk2, err := os.ReadFile(filepath.Join(dir, "latest.json"))
	require.NoError(t, err)
	assert.Equal(t, public2.Body.String(), string(onDisk2))
	entries, err = os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1, "no leftover temp files after a second upload")
}

func TestUploadInstallerLatestRejectsWrongArtifact(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	t.Setenv("INSTALLER_STORAGE_DIR", dir)

	r := gin.New()
	r.POST("/api/installers/latest", UploadInstallerLatest)

	newRequest := func(name, content string) *http.Request {
		var body strings.Builder
		mw := multipart.NewWriter(&body)
		part, err := mw.CreateFormFile("file", name)
		require.NoError(t, err)
		_, err = part.Write([]byte(content))
		require.NoError(t, err)
		require.NoError(t, mw.Close())
		req := httptest.NewRequest(http.MethodPost, "/api/installers/latest", strings.NewReader(body.String()))
		req.Header.Set("Content-Type", mw.FormDataContentType())
		return req
	}

	for _, tc := range []struct {
		name    string
		file    string
		content string
	}{
		{"wrong extension", "latest.txt", sampleLatestManifest},
		{"downloads.json", "downloads.json", `{"version":"1.2.3","files":[]}`},
		{"broken json", "latest.json", `{oops`},
		{
			"missing signature",
			"latest.json",
			`{"version":"1.2.3","platforms":{"windows-x86_64":{"url":"https://example.com/a.exe"}}}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, newRequest(tc.file, tc.content))
			var resp map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			assert.Equal(t, false, resp["success"], "must not publish an invalid manifest: "+w.Body.String())
		})
	}

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	assert.Empty(t, entries, "a rejected upload must not leave a file behind")
}
