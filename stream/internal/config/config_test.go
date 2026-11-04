package config

import (
	"reflect"
	"testing"
)

func TestStreamCORSOrigins(t *testing.T) {
	t.Setenv("STREAM_CORS_ORIGINS", " https://a.example , https://b.example, , https://a.example ")
	want := []string{"https://a.example", "https://b.example"}
	if got := Load().CORSOrigins; !reflect.DeepEqual(got, want) {
		t.Errorf("origins = %v, want %v", got, want)
	}

	t.Setenv("STREAM_CORS_ORIGINS", "")
	if got := Load().CORSOrigins; len(got) != 0 {
		t.Errorf("empty setting should disable CORS, got %v", got)
	}
}
