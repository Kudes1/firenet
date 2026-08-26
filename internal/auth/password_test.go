package auth

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "" || hash == "correct horse battery staple" {
		t.Fatalf("HashPassword returned a suspicious hash: %q", hash)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Fatal("VerifyPassword rejected the correct password")
	}
	if VerifyPassword(hash, "wrong password") {
		t.Fatal("VerifyPassword accepted the wrong password")
	}
}
