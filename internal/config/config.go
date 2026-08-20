// Package config loads application configuration from environment variables.
package config

import "os"

// Config holds settings shared by every delivery adapter (CLI today, HTTP later).
type Config struct {
	LogLevel  string
	LogFormat string
}

// Load reads configuration from environment variables, falling back to defaults.
func Load() (Config, error) {
	return Config{
		LogLevel:  getEnv("FIRENET_LOG_LEVEL", "info"),
		LogFormat: getEnv("FIRENET_LOG_FORMAT", "text"),
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
