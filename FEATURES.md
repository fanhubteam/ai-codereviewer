# AI Code Reviewer Features

## Core Features

### 1. Event Triggers
- Automatically triggered on PR events (opened/reopened/synchronized)
- Manual trigger via `/code_review` command in PR comments
- Issue comment event handling

### 2. Test Coverage Analysis
- Detects missing tests in changed files
- Identifies testable file types based on extensions
- Excludes test files and configuration files
- Supports multiple test file patterns and locations
- Test exemption handling via keywords in PR description

### 3. AI Code Review
- Supports multiple AI providers (OpenAI/Gemini)
- Generates contextual code reviews in Portuguese
- Line-specific comments in PR
- JSON-structured review responses
- Temperature and token controls for AI responses

### 4. Webhook Integration
- Configurable webhook notifications
- Comprehensive payload including:
  - Repository information
  - PR details (title, description, author, etc.)
  - Test analysis results
  - AI-generated exemption reasons
  - Event metadata and timestamps

## Detailed Functionality

### Test Analysis
- File patterns supported:
  ```
  - test/**, tests/**
  - *test*, *Test*
  - *spec*, *Spec*
  - *.test.{js,ts}
  - *.spec.{js,ts}
  - __tests__/**
  - test_*.py, *_test.py
  ```

- Testable file extensions:
  ```
  .py, .js, .ts, .jsx, .tsx, .vue, .rb, .php, .java, .go, .cs, .cpp, .rs
  ```

- Excluded patterns:
  ```
  .config., .conf., .d.ts, settings.py, urls.py, wsgi.py, asgi.py, manage.py
  ```

### Test Exemption Keywords
