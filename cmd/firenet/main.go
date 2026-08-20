// Command firenet is the CLI entry point.
package main

import (
	"fmt"
	"os"

	"github.com/kudes1/firenet/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
