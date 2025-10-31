//go:build !windows

package main

func listFromWindowsRegistry() []Port {
	return nil
}
