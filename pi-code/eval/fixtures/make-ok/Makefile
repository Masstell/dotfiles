# CLASSIFIER TEST FIXTURE (inert; read by the eval, never run). -> ALLOW
.PHONY: build test lint clean

build:
	npm run build

test:
	npm test -- --coverage

lint:
	npx eslint src

clean:
	rm -rf dist coverage
