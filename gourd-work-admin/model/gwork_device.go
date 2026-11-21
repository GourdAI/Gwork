package model

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GworkDevice persists one desktop client registration of a user account.
// Online state is process memory (service.GworkHub), never a database column;
// LastSeen is the millisecond timestamp of the last connect/disconnect event.
type GworkDevice struct {
	Id         int    `json:"id" gorm:"primaryKey"`
	UserId     int    `json:"user_id" gorm:"column:user_id;not null;index;uniqueIndex:idx_gwork_devices_user_device,priority:1"`
	DeviceId   string `json:"device_id" gorm:"column:device_id;type:varchar(64);not null;uniqueIndex:idx_gwork_devices_user_device,priority:2"`
	Name       string `json:"name" gorm:"type:varchar(128)"`
	Platform   string `json:"platform" gorm:"type:varchar(16)"`
	AppVersion string `json:"app_version" gorm:"column:app_version;type:varchar(64)"`
	LastSeen   int64  `json:"last_seen" gorm:"column:last_seen;type:bigint;not null;default:0"`
}

func (GworkDevice) TableName() string {
	return "gwork_devices"
}

// UpsertGworkDevice inserts the device row or refreshes name/platform/
// app_version/last_seen when the (user_id, device_id) pair already exists.
func UpsertGworkDevice(userId int, deviceId, name, platform, appVersion string) error {
	device := GworkDevice{
		UserId:     userId,
		DeviceId:   deviceId,
		Name:       name,
		Platform:   platform,
		AppVersion: appVersion,
		LastSeen:   time.Now().UnixMilli(),
	}
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "device_id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"name":        name,
			"platform":    platform,
			"app_version": appVersion,
			"last_seen":   device.LastSeen,
		}),
	}).Create(&device).Error
}

func ListGworkDevices(userId int) ([]GworkDevice, error) {
	var devices []GworkDevice
	err := DB.Where("user_id = ?", userId).Order("last_seen DESC").Find(&devices).Error
	return devices, err
}

// GetGworkDevice returns nil when the account has no such device row.
func GetGworkDevice(userId int, deviceId string) (*GworkDevice, error) {
	var device GworkDevice
	err := DB.Where("user_id = ? AND device_id = ?", userId, deviceId).First(&device).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &device, nil
}

func DeleteGworkDevice(userId int, deviceId string) error {
	return DB.Where("user_id = ? AND device_id = ?", userId, deviceId).Delete(&GworkDevice{}).Error
}

// TouchGworkDeviceLastSeen records the disconnect moment. A row deleted while
// the device was online simply matches nothing.
func TouchGworkDeviceLastSeen(userId int, deviceId string) error {
	return DB.Model(&GworkDevice{}).
		Where("user_id = ? AND device_id = ?", userId, deviceId).
		UpdateColumn("last_seen", time.Now().UnixMilli()).Error
}
