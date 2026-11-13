package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Installer packages are distributions of the desktop client. Only an
// administrator may manage them, while the manifest and the binaries are public
// so the landing page can offer downloads without a session.
//
// Deployment note: when the service sits behind a reverse proxy, configure
// client_max_body_size and proxy_read_timeout / proxy_send_timeout to cover the
// configured INSTALLER_MAX_SIZE_MB; otherwise the proxy may reject a package
// with 413 before Gin ever sees it.
const defaultInstallerMaxSizeMB int64 = 512

var installerPlatforms = map[string]struct{}{
	"windows": {},
	"macos":   {},
	"linux":   {},
}

var installerArches = map[string]struct{}{
	"x64":   {},
	"arm64": {},
}

// installerKindExtensions is the single source of truth for accepted package
// formats. The stored file always uses this canonical extension, never the
// client-supplied one.
var installerKindExtensions = map[string]string{
	"exe":      ".exe",
	"msi":      ".msi",
	"dmg":      ".dmg",
	"appimage": ".AppImage",
	"deb":      ".deb",
	"zip":      ".zip",
}

var installerVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

func installerStorageDir() string {
	if dir := os.Getenv("INSTALLER_STORAGE_DIR"); dir != "" {
		return dir
	}
	// Relative to the process working directory. The official image uses
	// WORKDIR /data with ./data:/data mounted, so packages persist there.
	return filepath.Join(".", "installers")
}

func installerMaxSizeBytes() int64 {
	mb, err := strconv.ParseInt(os.Getenv("INSTALLER_MAX_SIZE_MB"), 10, 64)
	// The last guard keeps mb<<20 from overflowing int64 on a malformed env var.
	if err != nil || mb <= 0 || mb > ((1<<63-1)>>20) {
		mb = defaultInstallerMaxSizeMB
	}
	return mb << 20
}

func validInstallerPlatform(value string) bool {
	_, ok := installerPlatforms[value]
	return ok
}

func validInstallerArch(value string) bool {
	_, ok := installerArches[value]
	return ok
}

func validInstallerKind(value string) bool {
	_, ok := installerKindExtensions[value]
	return ok
}

func validInstallerVersion(value string) bool {
	return installerVersionPattern.MatchString(value)
}

// installerExtensionMatches reports whether an uploaded file name carries the
// extension required by its kind. Comparison is case-insensitive because
// .AppImage and .EXE are both common in the wild.
func installerExtensionMatches(kind string, fileName string) bool {
	want, ok := installerKindExtensions[kind]
	if !ok {
		return false
	}
	return strings.EqualFold(filepath.Ext(fileName), want)
}

// safeInstallerStoredName rejects anything that is not a bare file name, so a
// tampered database row can never escape the storage directory.
func safeInstallerStoredName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	return filepath.Base(name) == name && !strings.ContainsAny(name, `/\`)
}

func installerFilePath(storedName string) (string, bool) {
	if !safeInstallerStoredName(storedName) {
		return "", false
	}
	return filepath.Join(installerStorageDir(), storedName), true
}

// The desktop updater reads a single *bare* JSON document (tauri-plugin-updater
// schema: { version, notes, pub_date, platforms: { <os>-<arch>: {url, signature} } }).
// It is deliberately stored as one well-known file next to the installers rather
// than in the database: the public GET must return the uploaded bytes verbatim,
// with no ApiSuccess envelope and no rewrite of the URLs inside it.
const installerLatestFileName = "latest.json"
const installerLatestMaxBytes int64 = 1 << 20 // 1 MiB is plenty for a manifest

const installerLatestPublicPath = "/downloads/tauri/latest.json"
const installerLatestApiPath = "/api/installer-latest"

func installerLatestFilePath() string {
	return filepath.Join(installerStorageDir(), installerLatestFileName)
}

// installerLatestPlatform mirrors one platforms[*] entry of the static
// manifest. It must stay in lockstep with tauri-plugin-updater's
// ReleaseManifestPlatform { url: Url, signature: String }: BOTH fields are
// required at deserialization time (signature is String, not Option<String>,
// with no default). A manifest that omits a signature cannot even be parsed by
// the client — updater.check() fails before it can report the new version.
type installerLatestPlatform struct {
	Signature string `json:"signature"`
	URL       string `json:"url"`
}

type installerLatestDocument struct {
	Version   string                             `json:"version"`
	Notes     string                             `json:"notes"`
	PubDate   string                             `json:"pub_date"`
	Platforms map[string]installerLatestPlatform `json:"platforms"`
}

// installerLatestVersionPattern mirrors semver::Version (the crate the desktop
// client uses via parse_version, which strips a leading "v"). A version the
// client cannot parse makes check() fail before it can compare versions, so a
// free-form string like "release-2026" must be rejected at upload time.
// Grammar: MAJOR.MINOR.PATCH with optional -prerelease and +build metadata.
var installerLatestVersionPattern = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`)

// installerLatestPlatformKey mirrors the keys tauri-plugin-updater looks up:
// {os}-{arch} first, then {os}-{arch}-{bundle_type}. OS is linux|darwin|windows
// (macOS is "darwin", NOT "macos"), ARCH is x86_64|aarch64|i686|armv7, and the
// optional installer suffix comes from Installer::name(). A key outside this
// set (e.g. "win64" or "macos-arm64") yields TargetsNotFound on every real
// client: the manifest publishes successfully but nobody can ever update.
var installerLatestPlatformKey = regexp.MustCompile(`^(linux|darwin|windows)-(x86_64|aarch64|i686|armv7)(-(deb|rpm|appimage|app|msi|nsis))?$`)

// validateInstallerLatest must accept ONLY what tauri-plugin-updater 2.x can
// actually deserialize. Its RemoteRelease uses a custom Deserialize impl:
//   - version  -> semver::Version::from_str (leading "v" stripped)
//   - url      -> url::Url (absolute, needs a scheme + host)
//   - pub_date -> OffsetDateTime::parse(Rfc3339) when present
//   - platforms[*].signature is a required String, and every entry also
//     needs url; the client looks the entry up by its own OS-ARCH target.
// Accepting a manifest that violates any of these publishes a feed where
// updater.check() fails for every platform — the admin sees "upload succeeded"
// while no desktop client can ever detect the release. A downloads.json-style
// document (files:[...]) or a JSON array is rejected up front as well.
func validateInstallerLatest(body []byte) (installerLatestDocument, error) {
	var doc installerLatestDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return doc, fmt.Errorf("Invalid latest.json manifest: %s", err.Error())
	}
	version := strings.TrimSpace(doc.Version)
	if version == "" {
		return doc, fmt.Errorf("Invalid latest.json manifest: missing version")
	}
	if !installerLatestVersionPattern.MatchString(version) {
		return doc, fmt.Errorf("Invalid latest.json manifest: version %q is not a valid SemVer (the desktop updater parses it with semver::Version)", version)
	}
	if len(doc.Platforms) == 0 {
		return doc, fmt.Errorf("Invalid latest.json manifest: missing platforms")
	}
	for key, entry := range doc.Platforms {
		if !installerLatestPlatformKey.MatchString(key) {
			return doc, fmt.Errorf("Invalid latest.json manifest: platform key %q is not a valid updater target (expected {linux|darwin|windows}-{x86_64|aarch64|i686|armv7}, optionally -{installer})", key)
		}
		rawURL := strings.TrimSpace(entry.URL)
		if rawURL == "" {
			return doc, fmt.Errorf("Invalid latest.json manifest: platform %q has no url", key)
		}
		parsed, err := url.Parse(rawURL)
		if err != nil || !parsed.IsAbs() || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return doc, fmt.Errorf("Invalid latest.json manifest: platform %q has a url that is not an absolute http(s) URL: %q", key, rawURL)
		}
		if strings.TrimSpace(entry.Signature) == "" {
			return doc, fmt.Errorf("Invalid latest.json manifest: platform %q has no signature (tauri-plugin-updater rejects signature-less entries at parse time)", key)
		}
	}
	// pub_date is optional, but when present the client parses it as RFC 3339;
	// an unparseable value fails the whole manifest deserialization.
	if pubDate := strings.TrimSpace(doc.PubDate); pubDate != "" {
		if _, err := time.Parse(time.RFC3339, pubDate); err != nil {
			return doc, fmt.Errorf("Invalid latest.json manifest: pub_date %q is not RFC 3339", pubDate)
		}
	}
	return doc, nil
}

// installerLatestInfo is what the admin page shows. `data: null` means no
// manifest has been uploaded yet (the public GET then answers 404).
type installerLatestInfo struct {
	Version   string   `json:"version"`
	Notes     string   `json:"notes"`
	PubDate   string   `json:"pub_date"`
	Platforms []string `json:"platforms"`
	Size      int64    `json:"size"`
	UpdatedAt string   `json:"updated_at"`
	URL       string   `json:"url"`
	ApiURL    string   `json:"api_url"`
}

func readInstallerLatest() ([]byte, *installerLatestInfo, error) {
	path := installerLatestFilePath()
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	doc, err := validateInstallerLatest(body)
	if err != nil {
		return nil, nil, err
	}
	st, statErr := os.Stat(path)
	info := &installerLatestInfo{
		Version:   doc.Version,
		Notes:     doc.Notes,
		PubDate:   doc.PubDate,
		Platforms: make([]string, 0, len(doc.Platforms)),
		Size:      int64(len(body)),
		URL:       installerLatestPublicPath,
		ApiURL:    installerLatestApiPath,
	}
	for key := range doc.Platforms {
		info.Platforms = append(info.Platforms, key)
	}
	sort.Strings(info.Platforms)
	if statErr == nil {
		info.UpdatedAt = st.ModTime().UTC().Format(time.RFC3339)
	}
	return body, info, nil
}

// ---------------------------------------------------------------------------
// Admin handlers
// ---------------------------------------------------------------------------

func ListInstallers(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	installers, total, err := model.GetAllInstallers(pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(installers)
	common.ApiSuccess(c, pageInfo)
}

func UploadInstaller(c *gin.Context) {
	version := strings.TrimSpace(c.PostForm("version"))
	platform := strings.TrimSpace(c.PostForm("platform"))
	arch := strings.TrimSpace(c.PostForm("arch"))
	kind := strings.TrimSpace(c.PostForm("kind"))
	releaseNotes := c.PostForm("release_notes")

	if !validInstallerVersion(version) {
		common.ApiErrorT(c, "Invalid installer version")
		return
	}
	if !validInstallerPlatform(platform) {
		common.ApiErrorT(c, "Invalid installer platform")
		return
	}
	if !validInstallerArch(arch) {
		common.ApiErrorT(c, "Invalid installer architecture")
		return
	}
	if !validInstallerKind(kind) {
		common.ApiErrorT(c, "Invalid installer kind")
		return
	}

	src, fileHeader, err := c.Request.FormFile("file")
	if err != nil {
		common.ApiErrorT(c, "Installer file is required")
		return
	}
	defer src.Close()

	if !installerExtensionMatches(kind, fileHeader.Filename) {
		common.ApiErrorT(c, "Installer file extension does not match kind")
		return
	}

	maxBytes := installerMaxSizeBytes()
	if fileHeader.Size > maxBytes {
		common.ApiErrorT(c, "Installer file exceeds size limit")
		return
	}

	dir := installerStorageDir()
	if err = os.MkdirAll(dir, 0755); err != nil {
		common.ApiErrorT(c, "Failed to store installer file")
		return
	}

	// The stored name is server generated: a UUID plus the canonical extension
	// for the kind. Neither the uploaded name nor any client field is ever used
	// to build a path.
	storedName := uuid.New().String() + installerKindExtensions[kind]
	tmpPath := filepath.Join(dir, storedName+".tmp")
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0644)
	if err != nil {
		common.ApiErrorT(c, "Failed to store installer file")
		return
	}

	// Hash while streaming, so a package is never buffered in memory twice.
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(src, maxBytes+1))
	closeErr := tmp.Close()
	cleanupTmp := func() { _ = os.Remove(tmpPath) }

	if written > maxBytes {
		cleanupTmp()
		common.ApiErrorT(c, "Installer file exceeds size limit")
		return
	}
	if copyErr != nil || closeErr != nil {
		cleanupTmp()
		common.ApiErrorT(c, "Failed to store installer file")
		return
	}

	finalPath := filepath.Join(dir, storedName)
	if err = os.Rename(tmpPath, finalPath); err != nil {
		cleanupTmp()
		common.ApiErrorT(c, "Failed to store installer file")
		return
	}
	// Executables are served as downloads only; never mark them executable on
	// the server's own filesystem.
	if err = os.Chmod(finalPath, 0644); err != nil {
		_ = os.Remove(finalPath)
		common.ApiErrorT(c, "Failed to store installer file")
		return
	}

	installer := &model.Installer{
		Version:      version,
		Platform:     platform,
		Arch:         arch,
		Kind:         kind,
		FileName:     filepath.Base(fileHeader.Filename),
		StoredName:   storedName,
		Size:         written,
		Sha256:       hex.EncodeToString(hasher.Sum(nil)),
		ReleaseNotes: releaseNotes,
		Enabled:      true,
	}
	if err = model.CreateInstaller(installer); err != nil {
		_ = os.Remove(finalPath)
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, installer)
}

type updateInstallerRequest struct {
	Version      *string `json:"version"`
	Platform     *string `json:"platform"`
	Arch         *string `json:"arch"`
	Kind         *string `json:"kind"`
	Enabled      *bool   `json:"enabled"`
	ReleaseNotes *string `json:"release_notes"`
}

func UpdateInstaller(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	existing, err := model.GetInstallerById(id)
	if err != nil {
		common.ApiErrorT(c, "Installer not found")
		return
	}

	var req updateInstallerRequest
	if err = common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}

	// Only fields present in the request are written; a map also preserves
	// explicit zero values such as enabled=false and release_notes="".
	columns := map[string]any{}
	if req.Version != nil {
		value := strings.TrimSpace(*req.Version)
		if !validInstallerVersion(value) {
			common.ApiErrorT(c, "Invalid installer version")
			return
		}
		columns["version"] = value
	}
	if req.Platform != nil {
		value := strings.TrimSpace(*req.Platform)
		if !validInstallerPlatform(value) {
			common.ApiErrorT(c, "Invalid installer platform")
			return
		}
		columns["platform"] = value
	}
	if req.Arch != nil {
		value := strings.TrimSpace(*req.Arch)
		if !validInstallerArch(value) {
			common.ApiErrorT(c, "Invalid installer architecture")
			return
		}
		columns["arch"] = value
	}
	if req.Kind != nil {
		value := strings.TrimSpace(*req.Kind)
		if !validInstallerKind(value) {
			common.ApiErrorT(c, "Invalid installer kind")
			return
		}
		// The stored file keeps its original canonical extension. A kind change
		// would make the manifest describe a different format than the bytes on
		// disk, so it is only allowed when the stored file already matches.
		if !installerExtensionMatches(value, existing.StoredName) {
			common.ApiErrorT(c, "Installer file extension does not match kind")
			return
		}
		columns["kind"] = value
	}
	if req.Enabled != nil {
		columns["enabled"] = *req.Enabled
	}
	if req.ReleaseNotes != nil {
		columns["release_notes"] = *req.ReleaseNotes
	}

	if len(columns) > 0 {
		if err = model.UpdateInstaller(id, columns); err != nil {
			common.ApiError(c, err)
			return
		}
	}
	installer, err := model.GetInstallerById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, installer)
}

func DeleteInstaller(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	installer, err := model.GetInstallerById(id)
	if err != nil {
		common.ApiErrorT(c, "Installer not found")
		return
	}
	if err = model.DeleteInstaller(id); err != nil {
		common.ApiError(c, err)
		return
	}
	// Removing the record takes precedence: a stale file that cannot be
	// unlinked must not resurrect a deleted package.
	if path, ok := installerFilePath(installer.StoredName); ok {
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			common.SysError(common.LogText("failed to remove installer file %s: %s", installer.StoredName, err.Error()))
		}
	}
	common.ApiSuccess(c, nil)
}

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

type installerManifestFile struct {
	Name    string `json:"name"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	Version string `json:"version"`
	Sha256  string `json:"sha256"`
	URL     string `json:"url"`
}

type installerManifest struct {
	Version string                  `json:"version"`
	PubDate string                  `json:"pub_date"`
	Files   []installerManifestFile `json:"files"`
}

// buildInstallerManifest aggregates enabled packages into the on-disk
// downloads.json shape used by the Java-era website, so an existing client can
// match entries by {os, arch, kind} without a schema change. Version is the
// lexicographically greatest version; pub_date is the greatest UpdatedAt among
// records carrying that version.
func buildInstallerManifest(installers []*model.Installer) installerManifest {
	manifest := installerManifest{Files: make([]installerManifestFile, 0, len(installers))}
	var latestUpdated time.Time
	for _, item := range installers {
		if item.Version > manifest.Version {
			manifest.Version = item.Version
			latestUpdated = item.UpdatedAt
		} else if item.Version == manifest.Version && item.UpdatedAt.After(latestUpdated) {
			latestUpdated = item.UpdatedAt
		}
		manifest.Files = append(manifest.Files, installerManifestFile{
			Name:    item.FileName,
			OS:      item.Platform,
			Arch:    item.Arch,
			Kind:    item.Kind,
			Size:    item.Size,
			Version: item.Version,
			Sha256:  item.Sha256,
			URL:     fmt.Sprintf("/api/installer-download/%d", item.Id),
		})
	}
	if !latestUpdated.IsZero() {
		manifest.PubDate = latestUpdated.UTC().Format(time.RFC3339)
	}
	return manifest
}

func GetInstallerManifest(c *gin.Context) {
	installers, err := model.GetEnabledInstallers()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// Admin edits must be visible on the next request. data is an object, not
	// the string payload of serveRevalidatedJSON.
	c.Header("Cache-Control", "no-cache")
	common.ApiSuccess(c, buildInstallerManifest(installers))
}

func DownloadInstaller(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiErrorT(c, "Installer not found")
		return
	}
	installer, err := model.GetInstallerById(id)
	if err != nil {
		common.ApiErrorT(c, "Installer not found")
		return
	}
	// A disabled package must not stay downloadable through a known id even
	// though it no longer appears in the public manifest.
	if !installer.Enabled {
		common.ApiErrorT(c, "Installer not found")
		return
	}
	path, ok := installerFilePath(installer.StoredName)
	if !ok {
		common.ApiErrorT(c, "Installer not found")
		return
	}
	if _, err = os.Stat(path); err != nil {
		common.ApiErrorT(c, "Installer not found")
		return
	}

	c.Header("Content-Type", "application/octet-stream")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Checksum-Sha256", installer.Sha256)
	// FileAttachment sets Content-Disposition: attachment; filename="<FileName>".
	c.FileAttachment(path, installer.FileName)

	// Best effort: a failed counter must never break the download.
	if err = model.IncrementDownloadCount(id); err != nil {
		common.SysError(common.LogText("failed to increment installer download count %d: %s", id, err.Error()))
	}
}

// ---------------------------------------------------------------------------
// Auto-update manifest (latest.json) — upload by an admin, read by the desktop
// ---------------------------------------------------------------------------

// GetInstallerLatest serves the uploaded manifest *verbatim*. tauri-plugin-updater
// parses the response body as the release JSON, so an ApiSuccess wrapper here
// would make every update check fail with "Could not fetch a valid release JSON".
// Both the canonical static path and an /api alias are served so deployments
// behind a reverse proxy can point GWORK_UPDATE_URL at whichever is reachable.
func GetInstallerLatest(c *gin.Context) {
	body, _, err := readInstallerLatest()
	if err != nil {
		// tauri-plugin-updater 2.x only treats 204 as "no updates found" and
		// treats any other non-2xx as ReleaseNotFound. A 200 with an error
		// envelope is NOT safe: res.status().is_success() is true, so the
		// plugin tries to deserialize {success:false} as RemoteRelease and
		// reports a misleading parse error instead of "no update".
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	c.Header("Pragma", "no-cache")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(200, "application/json; charset=utf-8", body)
}

// GetInstallerLatestInfo gives the admin page a friendly view of the currently
// published manifest. A missing file is a normal state, not an error.
func GetInstallerLatestInfo(c *gin.Context) {
	_, info, err := readInstallerLatest()
	if err != nil {
		common.ApiSuccess(c, nil)
		return
	}
	common.ApiSuccess(c, info)
}

// UploadInstallerLatest stores an admin-supplied latest.json. The bytes are
// validated, then written with the same tmp->rename pattern as the packages, so
// a concurrent update check never observes a partially written manifest.
func UploadInstallerLatest(c *gin.Context) {
	src, fileHeader, err := c.Request.FormFile("file")
	if err != nil {
		common.ApiErrorMsg(c, "Latest manifest file is required")
		return
	}
	defer src.Close()

	if !strings.EqualFold(filepath.Ext(fileHeader.Filename), ".json") {
		common.ApiErrorMsg(c, "Latest manifest must be a .json file")
		return
	}

	body, err := io.ReadAll(io.LimitReader(src, installerLatestMaxBytes+1))
	if err != nil {
		common.ApiErrorMsg(c, "Failed to read latest.json manifest")
		return
	}
	if int64(len(body)) > installerLatestMaxBytes {
		common.ApiErrorMsg(c, "Latest manifest exceeds size limit")
		return
	}
	if _, err = validateInstallerLatest(body); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}

	dir := installerStorageDir()
	if err = os.MkdirAll(dir, 0755); err != nil {
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}
	finalPath := installerLatestFilePath()

	// A unique temp name keeps concurrent uploads from truncating each other's
	// file. os.Rename is atomic on the same filesystem, so a concurrent update
	// check always sees either the previous or the new complete manifest.
	tmp, err := os.CreateTemp(dir, "latest.json-*.tmp")
	if err != nil {
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}
	tmpPath := tmp.Name()
	cleanupTmp := func() { _ = os.Remove(tmpPath) }
	// os.CreateTemp uses 0600; keep the published file readable like the
	// installer packages so a separate static-server process can serve it.
	if err = tmp.Chmod(0644); err != nil {
		_ = tmp.Close()
		cleanupTmp()
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}
	if _, err = tmp.Write(body); err != nil {
		_ = tmp.Close()
		cleanupTmp()
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}
	if err = tmp.Close(); err != nil {
		cleanupTmp()
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}
	if err = os.Rename(tmpPath, finalPath); err != nil {
		cleanupTmp()
		common.ApiErrorMsg(c, "Failed to store latest.json manifest")
		return
	}

	_, info, err := readInstallerLatest()
	if err != nil {
		common.ApiErrorMsg(c, "Failed to read back latest.json manifest")
		return
	}
	common.ApiSuccess(c, info)
}
