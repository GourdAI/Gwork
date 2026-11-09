package controller

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInstallerEnumValidation(t *testing.T) {
	tests := []struct {
		name     string
		platform string
		arch     string
		kind     string
		wantOK   bool
	}{
		{"windows x64 exe is valid", "windows", "x64", "exe", true},
		{"windows x64 msi is valid", "windows", "x64", "msi", true},
		{"windows arm64 zip is valid", "windows", "arm64", "zip", true},
		{"macos arm64 dmg is valid", "macos", "arm64", "dmg", true},
		{"macos x64 dmg is valid", "macos", "x64", "dmg", true},
		{"linux x64 appimage is valid", "linux", "x64", "appimage", true},
		{"linux arm64 deb is valid", "linux", "arm64", "deb", true},
		{"unknown platform rejected", "solaris", "x64", "exe", false},
		{"unknown arch rejected", "windows", "ia32", "exe", false},
		{"unknown kind rejected", "windows", "x64", "rpm", false},
		{"case sensitive platform", "Windows", "x64", "exe", false},
		{"case sensitive arch", "windows", "X64", "exe", false},
		{"case sensitive kind", "windows", "x64", "EXE", false},
		{"empty fields rejected", "", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ok := validInstallerPlatform(tc.platform) &&
				validInstallerArch(tc.arch) &&
				validInstallerKind(tc.kind)
			assert.Equal(t, tc.wantOK, ok)
		})
	}
}

func TestInstallerVersionValidation(t *testing.T) {
	tests := []struct {
		name    string
		version string
		wantOK  bool
	}{
		{"plain semver", "1.2.3", true},
		{"zero version", "0.0.1", true},
		{"prerelease", "10.20.30-beta.1", true},
		{"prerelease with hyphen", "1.2.3-rc-1", true},
		{"build metadata rejected", "1.2.3-rc.1+build", false},
		{"trailing hyphen rejected", "1.2.3-", false},
		{"two segments rejected", "1.2", false},
		{"v prefix rejected", "v1.2.3", false},
		{"four segments rejected", "1.2.3.4", false},
		{"empty rejected", "", false},
		{"slash rejected", "1.2.3/evil", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.wantOK, validInstallerVersion(tc.version))
		})
	}
}

func TestInstallerExtensionMatches(t *testing.T) {
	tests := []struct {
		name     string
		kind     string
		fileName string
		wantOK   bool
	}{
		{"exe lower", "exe", "GWork_1.2.3_x64-setup.exe", true},
		{"exe upper case is accepted", "exe", "SETUP.EXE", true},
		{"msi", "msi", "GWork.msi", true},
		{"dmg", "dmg", "GWork.dmg", true},
		{"appimage canonical", "appimage", "GWork.AppImage", true},
		{"appimage mixed case", "appimage", "GWork.appimage", true},
		{"deb", "deb", "GWork.deb", true},
		{"zip", "zip", "GWork.zip", true},
		{"tar.gz is not accepted for zip", "zip", "GWork.tar.gz", false},
		{"wrong extension", "exe", "GWork.dmg", false},
		{"no extension", "exe", "GWork", false},
		{"unknown kind", "rpm", "GWork.rpm", false},
		{"extension still matches a traversal name", "exe", "../../etc/passwd.exe", true}, // stored name is server generated
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.wantOK, installerExtensionMatches(tc.kind, tc.fileName))
		})
	}
}

func TestSafeInstallerStoredName(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{"uuid with exe", "6d1e4a2b-4f9c-4a1e-9a10-1234567890ab.exe", true},
		{"uuid with appimage", "6d1e4a2b4f9c4a1e9a101234567890ab.AppImage", true},
		{"plain name", "package.AppImage", true},
		{"unix traversal", "../../etc/passwd", false},
		{"windows traversal", `..\..\windows\system32`, false},
		{"windows drive prefix", `C:\windows\system32\cmd.exe`, false},
		{"absolute unix", "/etc/passwd", false},
		{"dot", ".", false},
		{"dotdot", "..", false},
		{"empty", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, safeInstallerStoredName(tc.value))
			_, ok := installerFilePath(tc.value)
			assert.Equal(t, tc.want, ok)
		})
	}
}

func TestInstallerStorageDir(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{"unset falls back to working directory", "", filepath.Join(".", "installers")},
		{"configured absolute directory", "/data/packages", "/data/packages"},
		{"configured relative directory", "custom", "custom"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("INSTALLER_STORAGE_DIR", tc.value)
			assert.Equal(t, tc.want, installerStorageDir())
		})
	}
}

func TestInstallerMaxSizeBytes(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  int64
	}{
		{"default when unset", "", defaultInstallerMaxSizeMB << 20},
		{"custom value", "1024", int64(1024) << 20},
		{"zero falls back to default", "0", defaultInstallerMaxSizeMB << 20},
		{"negative falls back to default", "-1", defaultInstallerMaxSizeMB << 20},
		{"invalid falls back to default", "not-a-number", defaultInstallerMaxSizeMB << 20},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("INSTALLER_MAX_SIZE_MB", tc.value)
			assert.Equal(t, tc.want, installerMaxSizeBytes())
		})
	}
}

func TestBuildInstallerManifest(t *testing.T) {
	older := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 2, 2, 12, 30, 0, 0, time.UTC)

	t.Run("aggregates latest version and keeps field contract", func(t *testing.T) {
		items := []*model.Installer{
			{Id: 1, Version: "1.2.3", Platform: "windows", Arch: "x64", Kind: "exe", FileName: "a.exe", Sha256: "aa", Size: 100, UpdatedAt: older},
			{Id: 2, Version: "1.3.0", Platform: "macos", Arch: "arm64", Kind: "dmg", FileName: "b.dmg", Sha256: "bb", Size: 200, UpdatedAt: newer},
			{Id: 3, Version: "1.3.0", Platform: "linux", Arch: "x64", Kind: "appimage", FileName: "c.AppImage", Sha256: "cc", Size: 300, UpdatedAt: older},
		}
		manifest := buildInstallerManifest(items)

		assert.Equal(t, "1.3.0", manifest.Version)
		assert.Equal(t, newer.UTC().Format(time.RFC3339), manifest.PubDate)
		require.Len(t, manifest.Files, 3)
		assert.Equal(t, installerManifestFile{
			Name: "a.exe", OS: "windows", Arch: "x64", Kind: "exe",
			Size: 100, Version: "1.2.3", Sha256: "aa",
			URL: "/api/installer-download/1",
		}, manifest.Files[0])
		assert.Equal(t, "/api/installer-download/3", manifest.Files[2].URL)
	})

	t.Run("version is lexicographically greatest", func(t *testing.T) {
		items := []*model.Installer{
			{Id: 7, Version: "1.10.0", UpdatedAt: newer},
			{Id: 8, Version: "1.9.0", UpdatedAt: older},
		}
		manifest := buildInstallerManifest(items)

		assert.Equal(t, "1.9.0", manifest.Version)
		assert.Equal(t, older.UTC().Format(time.RFC3339), manifest.PubDate)
		require.Len(t, manifest.Files, 2)
		assert.Equal(t, "/api/installer-download/7", manifest.Files[0].URL)
		assert.Equal(t, "/api/installer-download/8", manifest.Files[1].URL)
	})

	t.Run("empty manifest serializes files as array not null", func(t *testing.T) {
		manifest := buildInstallerManifest(nil)
		assert.Equal(t, "", manifest.Version)
		assert.Equal(t, "", manifest.PubDate)
		require.NotNil(t, manifest.Files)

		body, err := common.Marshal(manifest)
		require.NoError(t, err)
		assert.True(t, strings.Contains(string(body), `"files":[]`), "files must be [] not null: %s", string(body))

		var decoded map[string]any
		require.NoError(t, common.Unmarshal(body, &decoded))
		assert.Contains(t, decoded, "version")
		assert.Contains(t, decoded, "pub_date")
		assert.Equal(t, []any{}, decoded["files"])
	})
}
