//go:build windows

package main

import (
	"os/exec"
	"regexp"
	"strings"
)

func listFromWindowsRegistry() []Port {
	// REG QUERY HKLM\HARDWARE\DEVICEMAP\SERIALCOMM
	out, err := exec.Command("reg", "query", `HKEY_LOCAL_MACHINE\HARDWARE\DEVICEMAP\SERIALCOMM`).CombinedOutput()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n")
	re := regexp.MustCompile(`\s+REG_SZ\s+(.+)$`)

	var found []Port
	for _, ln := range lines {
		if !strings.Contains(ln, "REG_SZ") {
			continue
		}
		m := re.FindStringSubmatch(ln)
		if len(m) < 2 {
			continue
		}
		com := strings.TrimSpace(m[1])
		if com == "" {
			continue
		}
		// DevicePath = 1ª coluna (antes do REG_SZ), se quiser:
		devPath := strings.TrimSpace(strings.SplitN(strings.TrimSpace(ln), "  ", 2)[0])

		p := Port{
			Path:         com,
			FriendlyName: devPath,
			DevicePath:   devPath,
			Source:       "SERIALCOMM",
		}
		lower := strings.ToLower(devPath + " " + com)
		if strings.Contains(lower, "com0com") || strings.Contains(lower, "virtual") ||
			strings.Contains(lower, "null-modem") || strings.Contains(lower, "emulator") ||
			strings.Contains(lower, "loopback") {
			p.IsVirtual = true
		}
		found = append(found, p)
	}
	sortPorts(found)
	return found
}
