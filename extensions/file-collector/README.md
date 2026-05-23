# @richardgill/pi-file-collector

Pi extension for collecting file/line evidence seen or cited during a session.

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install npm:@richardgill/pi-file-collector
```

## Configure

Create `file-collector.jsonc` in your extension config folder. The folder is `PI_EXTENSION_CONFIG_DIR` when set; otherwise Pi's agent directory (usually `~/.pi/agent`, or `PI_CODING_AGENT_DIR` if Pi is pointed elsewhere).

```jsonc
{
  "filenameSuffix": "file-line-events.jsonl",

  "collectReadTool": true,
  "collectWriteTool": true,
  "collectEditTool": true,
  "collectBashCommand": true,
  "collectBashOutput": true,
  "collectAssistantOutput": true,

  "appendSystemPrompt": "When citing files, always include file paths with line ranges like ./src/file.ts:12-18. Prefer this format over prose-only references. When using rg or grep always use -n",

  "bashShimCommands": [
    { "name": "cat", "capture": { "paths": { "from": "positionals" } } },
    {
      "name": "sed",
      "capture": {
        "paths": { "from": "positionalsAfter", "arg": "script" },
        "matchedText": { "from": "arg", "arg": "script" },
        "range": { "from": "sedPrintScript", "arg": "script" }
      }
    },
    {
      "name": "grep",
      "argv": { "valueOptions": ["-f"], "namedValueOptions": { "-e": "pattern" } },
      "capture": {
        "paths": { "from": "positionalsAfter", "arg": "pattern" },
        "matchedText": { "from": "arg", "arg": "pattern" }
      }
    },
    {
      "name": "head",
      "argv": { "valueOptions": ["-n", "--lines"] },
      "capture": {
        "paths": { "from": "lastPositional" },
        "range": { "from": "headLineCount", "option": "-n" }
      }
    },
    {
      "name": "tail",
      "argv": { "valueOptions": ["-n", "--lines"] },
      "capture": {
        "paths": { "from": "lastPositional" },
        "range": { "from": "tailLineCount", "option": "-n" }
      }
    }
  ],

  "assistantCitationPatterns": [
    {
      "regex": "(?:^|[\\s`\\\"'(<\\[])(?<path>[^\\s`\\\"'<>)]*?)#L(?<start>\\d+)(?:-L?(?<end>\\d+))?",
      "flags": "g"
    },
    {
      "regex": "(?:^|[\\s`\\\"'(<\\[])(?<path>[^\\s`\\\"'<>)]*?):(?<start>\\d+)(?:-(?<end>\\d+))?",
      "flags": "g"
    }
  ],

  "bashOutputPatterns": [
    { "regex": "^(?<path>.+?):(?<start>\\d+):(?<matchedText>.*)$", "flags": "gm" }
  ]
}
```

## Usage

- Records read-tool ranges, write/edit-tool ranges, declarative bash shim file arguments, grep-style bash output, and assistant file citations.
- Optionally appends `appendSystemPrompt` to the system prompt each user turn.
- Writes a JSONL per session beside the session file: `<session-basename>-file-line-events.jsonl`.
