const fs = require("node:fs");

const readInput = (processArgv) => {
  const [file, command, specJson, ...argv] = processArgv.slice(2);
  return { file, command, spec: JSON.parse(specJson), argv };
};

const toNumber = (value) => (/^\d+$/.test(String(value || "")) ? Number(value) : undefined);

const optionParts = (arg) => {
  const index = arg.indexOf("=");
  return index > 0 ? { name: arg.slice(0, index), value: arg.slice(index + 1) } : { name: arg };
};

const parseSedRange = (script) => {
  const range = String(script || "").match(/^(\d+)(?:,(\d+))?p/);
  if (!range) return {};

  const startLine = toNumber(range[1]);
  const endLine = toNumber(range[2]) || startLine;
  return startLine ? { startLine, endLine } : {};
};

const findLineCount = (argv, option) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const direct = arg === option ? toNumber(next) : undefined;
    const joined = arg.startsWith(option) ? toNumber(arg.slice(option.length)) : undefined;
    const count = direct || joined;
    if (count) return count;
  }

  return undefined;
};

const countFileLines = (target) => {
  try {
    const content = fs.readFileSync(target, "utf8");
    if (!content) return 0;

    const lines = content.split(/\r\n|\r|\n/);
    return lines.at(-1) === "" ? lines.length - 1 : lines.length;
  } catch {
    return undefined;
  }
};

const isExistingFileTarget = (target) => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};

const collectPositionals = (spec, argv) => {
  const valueOptions = new Set(spec.argv?.valueOptions || []);
  const namedValueOptions = spec.argv?.namedValueOptions || {};
  const stopAtDoubleDash = spec.argv?.stopAtDoubleDash !== false;
  const namedArgs = {};
  const namedIndexes = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (stopAtDoubleDash && arg === "--") {
      positionals.push(...argv.slice(index + 1));
      index = argv.length;
    } else if (arg.startsWith("-") && arg !== "-") {
      const option = optionParts(arg);
      const namedArg = namedValueOptions[option.name];
      if (namedArg) {
        const value = option.value === undefined ? argv[index + 1] : option.value;
        if (value !== undefined) namedArgs[namedArg] = value;
        if (option.value === undefined) index += 1;
      } else if (valueOptions.has(option.name) && option.value === undefined) {
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, namedArgs, namedIndexes };
};

const ensureArg = (parsedArgs, argName) => {
  if (parsedArgs.namedArgs[argName] !== undefined) return parsedArgs.namedArgs[argName];

  const first = parsedArgs.positionals[0];
  if (first !== undefined) {
    parsedArgs.namedArgs[argName] = first;
    parsedArgs.namedIndexes[argName] = 0;
  }

  return first;
};

const capturePaths = (spec, parsedArgs) => {
  const rule = spec.capture.paths;
  if (rule.from === "positionals") return parsedArgs.positionals;
  if (rule.from === "lastPositional") return parsedArgs.positionals.slice(-1);

  const argValue = ensureArg(parsedArgs, rule.arg);
  const index = parsedArgs.namedIndexes[rule.arg];
  return argValue !== undefined && index !== undefined
    ? parsedArgs.positionals.slice(index + 1)
    : parsedArgs.positionals;
};

const captureMatchedText = (spec, parsedArgs) => {
  const rule = spec.capture.matchedText;
  return rule?.from === "arg" ? ensureArg(parsedArgs, rule.arg) : undefined;
};

const captureRange = (spec, argv, parsedArgs, target) => {
  const rule = spec.capture.range;
  if (!rule) return {};
  if (rule.from === "sedPrintScript") return parseSedRange(ensureArg(parsedArgs, rule.arg));
  if (rule.from === "headLineCount") {
    const endLine = findLineCount(argv, rule.option);
    return endLine ? { startLine: 1, endLine } : {};
  }
  if (rule.from === "tailLineCount") {
    const count = findLineCount(argv, rule.option);
    const total = countFileLines(target);
    if (!count || !total) return {};
    return { startLine: Math.max(1, total - count + 1), endLine: total };
  }

  return {};
};

const createRecord = ({ command, spec, argv, parsedArgs, target, matchedText }) => ({
  command,
  path: target,
  matchedText,
  timestamp: new Date().toISOString(),
  ...captureRange(spec, argv, parsedArgs, target),
});

const appendExistingFileRecords = (input, targets, matchedText) => {
  for (const target of targets) {
    if (target && target !== "-" && isExistingFileTarget(target)) {
      const record = createRecord({ ...input, target, matchedText });
      fs.appendFileSync(input.file, `${JSON.stringify(record)}\n`);
    }
  }
};

const main = () => {
  const input = readInput(process.argv);
  const parsedArgs = collectPositionals(input.spec, input.argv);
  const targets = capturePaths(input.spec, parsedArgs);
  const matchedText = captureMatchedText(input.spec, parsedArgs);
  appendExistingFileRecords({ ...input, parsedArgs }, targets, matchedText);
};

main();
