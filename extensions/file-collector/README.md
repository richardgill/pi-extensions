# @richardgill/pi-file-collector

Pi extension for collecting file/line evidence seen or cited during a session.

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install npm:@richardgill/pi-file-collector
```

## Configure

Create `file-collector.jsonc` in your pi agent config folder:

```jsonc
{
  "commandName": "file-lines",

  "sidecarEnabled": true,
  "sidecarFilename": "file-line-events.jsonl",

  "collectReadTool": true,
  "collectBashCommand": true,
  "collectBashOutput": true,
  "collectAssistantOutput": true,

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

- Records read-tool ranges, declarative bash shim file arguments, grep-style bash output, and assistant file citations.
- Persists session entries as `file-line-event` and writes the sidecar JSONL beside persisted session files.
- `/file-lines` shows a summary of collected events on the current session branch.
