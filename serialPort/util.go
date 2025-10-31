package main

import (
	"regexp"
	"sort"
	"strconv"
)

var rxNum = regexp.MustCompile(`\d+`)

func extractNum(s string) int {
	if s == "" {
		return 0
	}
	m := rxNum.FindString(s)
	if m == "" {
		return 0
	}
	n, _ := strconv.Atoi(m)
	return n
}

func sortPorts(p []Port) {
	sort.Slice(p, func(i, j int) bool {
		ai := extractNum(p[i].Path)
		aj := extractNum(p[j].Path)
		if ai != aj {
			return ai < aj
		}
		// fallback por ordem alfabética
		return p[i].Path < p[j].Path
	})
}
