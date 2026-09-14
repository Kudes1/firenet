package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestSpansOverlapAndCovers(t *testing.T) {
	topo := testTopology()

	officeToDmz := ruleSpanOf(topo, rules.Rule{Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}})
	anyToDmz := ruleSpanOf(topo, rules.Rule{Src: []string{rules.Any}, Dst: []string{"dmz"}, Proto: rules.ProtoAny})
	officeToOffice := ruleSpanOf(topo, rules.Rule{Src: []string{"office"}, Dst: []string{"office"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}})

	if !spansOverlap(officeToDmz, anyToDmz) {
		t.Fatal("officeToDmz should overlap anyToDmz")
	}
	if !spanCovers(anyToDmz, officeToDmz) {
		t.Fatal("anyToDmz (any src, proto any) should cover the narrower officeToDmz")
	}
	if spanCovers(officeToDmz, anyToDmz) {
		t.Fatal("officeToDmz must not cover the broader anyToDmz")
	}
	if spansOverlap(officeToDmz, officeToOffice) {
		t.Fatal("disjoint dst (dmz vs office) must not overlap")
	}
}

func TestProtoOverlapsAndCovers(t *testing.T) {
	if !protoOverlaps(rules.ProtoAny, rules.ProtoTCP) {
		t.Fatal("any overlaps tcp")
	}
	if protoOverlaps(rules.ProtoTCP, rules.ProtoUDP) {
		t.Fatal("tcp/udp must not overlap")
	}
	if !protoCovers(rules.ProtoAny, rules.ProtoTCP) {
		t.Fatal("any covers tcp")
	}
	if protoCovers(rules.ProtoTCP, rules.ProtoAny) {
		t.Fatal("tcp must not cover any")
	}
}
