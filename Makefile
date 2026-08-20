BINARY := firenet
BIN_DIR := bin

.PHONY: build run test vet fmt tidy clean

build:
	go build -o $(BIN_DIR)/$(BINARY) ./cmd/firenet

run:
	go run ./cmd/firenet

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

tidy:
	go mod tidy

clean:
	rm -rf $(BIN_DIR)
