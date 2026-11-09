package model

import (
	"time"

	"gorm.io/gorm"
)

// Installer stores metadata for one desktop client installation package. The
// binary itself lives on the local disk under the installer storage directory;
// only the server-generated StoredName is kept here, so a client-supplied file
// name can never become a path component.
type Installer struct {
	Id            int       `json:"id" gorm:"primaryKey"`
	Version       string    `json:"version" gorm:"type:varchar(64);not null"`
	Platform      string    `json:"platform" gorm:"type:varchar(16);not null"`
	Arch          string    `json:"arch" gorm:"type:varchar(16);not null"`
	Kind          string    `json:"kind" gorm:"type:varchar(16);not null"`
	FileName      string    `json:"file_name" gorm:"type:varchar(256)"`
	StoredName    string    `json:"stored_name" gorm:"type:varchar(128)"`
	Size          int64     `json:"size"`
	Sha256        string    `json:"sha256" gorm:"type:varchar(64)"`
	ReleaseNotes  string    `json:"release_notes" gorm:"type:text"`
	Enabled       bool      `json:"enabled"`
	DownloadCount int64     `json:"download_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (Installer) TableName() string {
	return "installers"
}

func CreateInstaller(installer *Installer) error {
	// Enabled is a business rule rather than a database default: GORM boolean
	// default tags are normalized differently by MySQL and PostgreSQL and make
	// AutoMigrate issue repeated ALTER TABLE statements on restart.
	installer.Enabled = true
	return DB.Create(installer).Error
}

func GetInstallerById(id int) (*Installer, error) {
	var installer Installer
	if err := DB.Where("id = ?", id).First(&installer).Error; err != nil {
		return nil, err
	}
	return &installer, nil
}

func GetAllInstallers(offset int, limit int) ([]*Installer, int64, error) {
	var installers []*Installer
	var total int64
	if err := DB.Model(&Installer{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := DB.Order("created_at DESC").Offset(offset).Limit(limit).Find(&installers).Error; err != nil {
		return nil, 0, err
	}
	return installers, total, nil
}

func GetEnabledInstallers() ([]*Installer, error) {
	var installers []*Installer
	if err := DB.Where("enabled = ?", true).Order("created_at DESC").Find(&installers).Error; err != nil {
		return nil, err
	}
	return installers, nil
}

// UpdateInstaller writes only the columns supplied by the caller. A map keeps
// explicit zero values (Enabled=false, an empty ReleaseNotes) and never
// overwrites DownloadCount or the storage fields with a stale snapshot.
func UpdateInstaller(id int, columns map[string]any) error {
	return DB.Model(&Installer{}).Where("id = ?", id).Updates(columns).Error
}

func DeleteInstaller(id int) error {
	return DB.Where("id = ?", id).Delete(&Installer{}).Error
}

func IncrementDownloadCount(id int) error {
	return DB.Model(&Installer{}).Where("id = ?", id).
		UpdateColumn("download_count", gorm.Expr("download_count + 1")).Error
}
