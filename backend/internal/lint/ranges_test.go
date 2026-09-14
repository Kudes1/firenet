package lint

import (
	"reflect"
	"testing"
)

func TestMergeIntervals(t *testing.T) {
	tests := []struct {
		name string
		in   []interval
		want []interval
	}{
		{"empty", nil, nil},
		{"single", []interval{{10, 20}}, []interval{{10, 20}}},
		{"disjoint stays separate", []interval{{10, 20}, {30, 40}}, []interval{{10, 20}, {30, 40}}},
		{"overlapping merges", []interval{{10, 25}, {20, 40}}, []interval{{10, 40}}},
		{"touching merges", []interval{{10, 20}, {21, 30}}, []interval{{10, 30}}},
		{"unsorted input sorts first", []interval{{30, 40}, {10, 20}}, []interval{{10, 20}, {30, 40}}},
		{"contained interval absorbed", []interval{{10, 40}, {15, 20}}, []interval{{10, 40}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mergeIntervals(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("mergeIntervals(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestIntervalsOverlap(t *testing.T) {
	tests := []struct {
		name string
		a, b []interval
		want bool
	}{
		{"disjoint", []interval{{0, 10}}, []interval{{20, 30}}, false},
		{"touching but not overlapping", []interval{{0, 10}}, []interval{{11, 20}}, false},
		{"overlapping", []interval{{0, 10}}, []interval{{5, 20}}, true},
		{"one contains other", []interval{{0, 100}}, []interval{{40, 50}}, true},
		{"multi-range hit on second pair", []interval{{0, 10}, {100, 110}}, []interval{{50, 60}, {105, 120}}, true},
		{"empty b", []interval{{0, 10}}, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := intervalsOverlap(tt.a, tt.b); got != tt.want {
				t.Fatalf("intervalsOverlap(%v, %v) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestIntervalsCover(t *testing.T) {
	tests := []struct {
		name              string
		covering, covered []interval
		want              bool
	}{
		{"exact match", []interval{{0, 100}}, []interval{{0, 100}}, true},
		{"fully inside", []interval{{0, 100}}, []interval{{20, 30}}, true},
		{"partially outside", []interval{{0, 100}}, []interval{{90, 110}}, false},
		{"covered spans two disjoint covering ranges — not covered by either alone", []interval{{0, 50}, {60, 100}}, []interval{{40, 70}}, false},
		{"multiple covered ranges all inside", []interval{{0, 100}}, []interval{{10, 20}, {80, 90}}, true},
		{"empty covered is vacuously covered", []interval{{0, 10}}, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := intervalsCover(tt.covering, tt.covered); got != tt.want {
				t.Fatalf("intervalsCover(%v, %v) = %v, want %v", tt.covering, tt.covered, got, tt.want)
			}
		})
	}
}
