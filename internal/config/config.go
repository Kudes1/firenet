// Package config loads application configuration from environment variables.
package config

import "os"

// Config holds settings shared by every delivery adapter (CLI today, HTTP later).
type Config struct {
	LogLevel      string
	LogFormat     string
	DatabaseURL   string
	AdminUsername string
	AdminPassword string
}

// Load reads configuration from environment variables, falling back to defaults.
func Load() (Config, error) {
	return Config{
		LogLevel:      getEnv("FIRENET_LOG_LEVEL", "info"),
		LogFormat:     getEnv("FIRENET_LOG_FORMAT", "text"),
		DatabaseURL:   getEnv("FIRENET_DATABASE_URL", ""),
		AdminUsername: getEnv("FIRENET_ADMIN_USER", ""),
		AdminPassword: getEnv("FIRENET_ADMIN_PASSWORD", ""),
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
