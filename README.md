# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages AI providers (OpenAI or Gemini) to provide intelligent feedback and suggestions on
your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process.

## Features

- Reviews pull requests using OpenAI's GPT-4 or Google's Gemini API
- Provides intelligent comments and suggestions for improving your code
- Automatic test coverage verification
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

## Setup

1. You'll need an API key from either OpenAI or Google (Gemini). Sign up for an API key at:
   - OpenAI: [OpenAI Platform](https://platform.openai.com/signup)
   - Google AI: [Google AI Studio](https://makersuite.google.com/app/apikey)

2. Add your chosen API key as a GitHub Secret in your repository with an appropriate name (e.g., `OPENAI_API_KEY` or `GOOGLE_API_KEY`).

3. Create a `.github/workflows/code_review.yml` file in your repository and add the following content:

```yaml
name: AI Code Reviewer

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: your-username/ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "gemini"
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          GEMINI_MODEL: "gemini-1.5-pro" # Using Gemini 1.5 Pro
          exclude: "**/*.json, **/*.md"
          BOT_NAME: "QuatroDois"
          BOT_IMAGE_URL: "your-image-url"
```

4. Replace `your-username` with your GitHub username or organization name where the AI Code Reviewer repository is
   located.

5. Customize the `exclude` input if you want to ignore certain file patterns from being reviewed.

6. Commit the changes to your repository, and AI Code Reviewer will start working on your future pull requests.

### Using OpenAI (Default)

## How It Works

The AI Code Reviewer GitHub Action retrieves the pull request diff, filters out excluded files, and sends code chunks to
the OpenAI API. It then generates review comments based on the AI's response and adds them to the pull request.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub
Action.

Let the maintainer generate the final package (`yarn build` & `yarn package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
