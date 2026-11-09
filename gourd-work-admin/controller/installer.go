package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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
