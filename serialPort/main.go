package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	serial "go.bug.st/serial"
)

type Port struct {
	Path           string `json:"path"`           // "COM3" ou "/dev/ttyUSB0"
	FriendlyName   string `json:"friendlyName"`   // opcional (Windows: \Device\SerialX)
	DevicePath     string `json:"devicePath"`     // opcional (Windows: nome do valor no REG)
	Manufacturer   string `json:"manufacturer"`   // se disponível (n/a no mínimo)
	PNPId          string `json:"pnpId"`          // se disponível (n/a no mínimo)
	DeviceLocation string `json:"deviceLocation"` // se disponível (n/a no mínimo)
	ProductId      string `json:"productId"`      // se disponível (n/a no mínimo)

	Source    string `json:"source"`    // "SERIALCOMM", "serial", "SERIALCOMM+serial"
	IsVirtual bool   `json:"isVirtual"` // heurística (Windows)
}

// listPorts:
// - Windows: mescla SERIALCOMM (registro) + serial.GetPortsList()
// - Outros: serial.GetPortsList() apenas
func listPorts() ([]Port, error) {
	var final []Port

	// 1) Base via biblioteca (cross-platform)
	base, _ := serial.GetPortsList()
	baseMap := make(map[string]Port)
	for _, p := range base {
		key := normKey(p)
		baseMap[key] = Port{
			Path:   p,
			Source: "serial",
		}
	}

	// 2) Enriquecer/mesclar com Registro no Windows
	reg := listFromWindowsRegistry() // em windows_registry.go (windows) ou stub (outros)
	regMap := make(map[string]Port)
	for _, r := range reg {
		regMap[normKey(r.Path)] = r
	}

	// Mescla priorizando SERIALCOMM (quando existir)
	keys := make(map[string]struct{})
	for k := range baseMap {
		keys[k] = struct{}{}
	}
	for k := range regMap {
		keys[k] = struct{}{}
	}

	for k := range keys {
		b, hasB := baseMap[k]
		r, hasR := regMap[k]
		switch {
		case hasB && hasR:
			// prioriza Registro, marca origem combinada
			r.Source = "SERIALCOMM+serial"
			final = append(final, r)
		case hasR:
			final = append(final, r)
		case hasB:
			final = append(final, b)
		}
	}

	sortPorts(final)
	return final, nil
}

func normKey(s string) string {
	return stringsToUpperASCII(s)
}

func stringsToUpperASCII(s string) string {
	// evitar locale issues: ASCII only
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] = b[i] - 32
		}
	}
	return string(b)
}

func usage() {
	fmt.Fprintln(os.Stderr, "uso: lasecplot-helper [list]\n       lasecplot-helper --open PORT --baud N [--read] [--timeout ms]")
}

func main() {
	var (
		openPort = flag.String("open", "", "Porta serial para abrir (ex.: COM3, /dev/ttyUSB0)")
		baud     = flag.Int("baud", 115200, "Baud rate (ex.: 115200)")
		doRead   = flag.Bool("read", false, "Ler da porta (stdout)")
		timeout  = flag.Int("timeout", 2000, "Timeout de leitura (ms)")
	)
	flag.Parse()

	// Se não especificou flags que abrem porta, default é listar
	if *openPort == "" {
		ports, err := listPorts()
		if err != nil {
			fmt.Fprintln(os.Stderr, "erro:", err)
			os.Exit(2)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(ports)
		return
	}

	// Abrir porta
	mode := &serial.Mode{BaudRate: *baud}
	p, err := serial.Open(*openPort, mode)
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro ao abrir:", err)
		os.Exit(3)
	}
	defer p.Close()

	if *doRead {
		_ = p.SetReadTimeout(time.Duration(*timeout) * time.Millisecond)
		_, _ = io.Copy(os.Stdout, p)
	} else {
		// somente abrir e sair (sucesso)
		fmt.Println("OK: porta aberta")
	}
}
