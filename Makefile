BINARY := firenet
BIN_DIR := bin

.PHONY: build run dev test fe-test fe-build test-e2e vet fmt tidy bin clean

build:
	docker compose build backend

run:
	docker compose up --build

dev:
	docker compose up -d --build

test:
	docker compose --profile test run --rm --build backend-test

fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build

test-e2e: bin
	cd e2e && npx playwright test

vet:
	docker compose --profile test run --rm --build backend-test go vet ./...

fmt:
	docker compose --profile test run --rm -v ./backend:/src backend-test gofmt -l -w .

tidy:
	docker compose --profile test run --rm -v ./backend:/src backend-test go mod tidy

bin:
	mkdir -p $(BIN_DIR)
	docker build --target build -t $(BINARY)-build-img ./backend
	-docker rm -f $(BINARY)-bin-tmp >/dev/null 2>&1
	docker create --name $(BINARY)-bin-tmp $(BINARY)-build-img
	docker cp $(BINARY)-bin-tmp:/out/$(BINARY) $(BIN_DIR)/$(BINARY)
	docker rm $(BINARY)-bin-tmp

clean:
	rm -rf $(BIN_DIR)
