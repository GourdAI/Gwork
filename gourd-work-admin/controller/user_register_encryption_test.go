package controller

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/QuantumNous/new-api/common"
)

// TestRegisterRejectsPlaintextWhenPasswordEncryptionIsOn pins the H-3 fix.
//
// Before it, `POST /api/user/register` only ever read a plaintext `password`,
// so turning PASSWORD_LOGIN_ENCRYPTION on encrypted the *login* form while the
// *register* form kept putting the same password on the wire in the clear — the
// switch looked like it protected "the password" but protected only one of the
// two endpoints that carry it, and a plaintext register still succeeded.
func TestRegisterRejectsPlaintextWhenPasswordEncryptionIsOn(t *testing.T) {
	db := setupUserModelKeyRegisterTestDB(t)

	privateKeyPEM, err := common.GeneratePasswordEncryptionPrivateKey()
	require.NoError(t, err)
	require.NoError(t, common.LoadPasswordEncryptionPrivateKey(privateKeyPEM))

	previousEncryption := common.PasswordLoginEncryptionEnabled
	t.Cleanup(func() { common.PasswordLoginEncryptionEnabled = previousEncryption })

	common.RegisterEnabled = true
	common.PasswordRegisterEnabled = true
	common.EmailVerificationEnabled = false
	common.QuotaForNewUser = 0
	common.PasswordLoginEncryptionEnabled = true

	post := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/user/register", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		Register(c)
		return recorder
	}

	// 1. Plaintext password with encryption ON → refused before any DB work.
	plaintext := post(`{"username":"plain-user","password":"plaintext-pass-1"}`)
	require.False(t,
		strings.Contains(plaintext.Body.String(), `"success":true`),
		"plaintext register must not succeed while PASSWORD_LOGIN_ENCRYPTION is on: %s",
		plaintext.Body.String(),
	)
	require.Contains(t, plaintext.Body.String(), "Invalid parameters")

	// 2. Ciphertext without a key id → refused (the id selects the active key).
	missingKeyID := post(fmt.Sprintf(`{"username":"plain-user","password_encrypted":%q}`, "v2.abc.def.ghi"))
	require.False(t, strings.Contains(missingKeyID.Body.String(), `"success":true`), missingKeyID.Body.String())

	// 3. Malformed envelope → refused, and the envelope is never stored verbatim
	//    as if it were a password (a decoder bug would happily keep "v2.x.y.z").
	keyID, publicKeyPEM := common.PasswordEncryptionPublicKey()
	require.NotEmpty(t, keyID)
	malformed := post(fmt.Sprintf(`{"username":"plain-user","password_encrypted":"v2.notbase64.aa.bb","encryption_key_id":%q}`, keyID))
	require.False(t, strings.Contains(malformed.Body.String(), `"success":true`), malformed.Body.String())

	// 4. A correctly encrypted password must clear the encryption gate and
	//    actually create the account — this is the "the switch works for
	//    register too" half of the fix.
	envelope, err := encryptPasswordV2ForTest("plaintext-pass-1", publicKeyPEM, keyID)
	require.NoError(t, err)
	encrypted := post(fmt.Sprintf(`{"username":"cipher-user","password_encrypted":%q,"encryption_key_id":%q}`, envelope, keyID))
	require.Contains(t, encrypted.Body.String(), `"success":true`,
		"a valid v2 envelope must register: %s", encrypted.Body.String())

	// The stored password is the decrypted plaintext (later hashed by the model
	// layer), never the envelope. Assert the *hash* verifies against the exact
	// plaintext — `NotContains(stored, "v2.")` alone would also pass if we had
	// stored a hash of the key id or an empty string.
	var stored string
	require.NoError(t, db.Raw(`SELECT password FROM users WHERE username = ?`, "cipher-user").Row().Scan(&stored))
	require.NotContains(t, stored, "v2.", "envelope must not be persisted as the password")
	require.True(t, common.ValidatePasswordAndHash("plaintext-pass-1", stored),
		"stored password must be the hash of the decrypted plaintext")
	require.False(t, common.ValidatePasswordAndHash("wrong-password", stored))
}

// Regression guard: turning PASSWORD_LOGIN_ENCRYPTION off (the default) must
// leave the old plaintext register path byte-for-byte compatible — legacy
// clients, cached web assets and third-party callers still send
// {username,password,email,verification_code,aff_code}. Also pins that a test
// which flips the global flag cannot leak into neighbouring tests.
func TestRegisterPlaintextStillWorksWhenEncryptionIsOff(t *testing.T) {
	db := setupUserModelKeyRegisterTestDB(t)
	previous := common.PasswordLoginEncryptionEnabled
	t.Cleanup(func() { common.PasswordLoginEncryptionEnabled = previous })
	common.PasswordLoginEncryptionEnabled = false

	common.RegisterEnabled = true
	common.PasswordRegisterEnabled = true
	common.EmailVerificationEnabled = false
	common.QuotaForNewUser = 0

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/register",
		strings.NewReader(`{"username":"legacy-user","password":"legacy-pass-123","email":"","verification_code":"","aff_code":""}`))
	c.Request.Header.Set("Content-Type", "application/json")
	Register(c)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"success":true`, recorder.Body.String())
	var stored string
	require.NoError(t, db.Raw(`SELECT password FROM users WHERE username = ?`, "legacy-user").Row().Scan(&stored))
	require.True(t, common.ValidatePasswordAndHash("legacy-pass-123", stored),
		"plaintext register must behave exactly as before the encryption refactor")
}

// encryptPasswordV2ForTest mirrors the browser's v2 envelope so the server-side
// decrypt path is exercised for real (no hand-written fixtures to drift).
func encryptPasswordV2ForTest(password, publicKeyPEM, keyID string) (string, error) {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return "", fmt.Errorf("public key PEM did not decode")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", err
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("public key is not RSA")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, rsaPub, key, []byte("password-v2"))
	if err != nil {
		return "", err
	}
	blockCipher, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(blockCipher)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	// AAD binds the envelope to the active key id — same as the browser.
	ciphertext := gcm.Seal(nil, nonce, []byte(password), []byte("password-v2:"+keyID))
	return "v2." +
		base64.StdEncoding.EncodeToString(wrapped) + "." +
		base64.StdEncoding.EncodeToString(nonce) + "." +
		base64.StdEncoding.EncodeToString(ciphertext), nil
}
