import path from 'node:path';
import pc from 'picocolors';
import type { TiktokenEncoding } from 'tiktoken';
import type { RepomixConfigMerged } from '../../config/configSchema.js';
import { RepomixError } from '../../shared/errorHandle.js';
import { initTaskRunner } from '../../shared/processConcurrency.js';
import type { RepomixProgressCallback } from '../../shared/types.js';
import type { ProcessedFile } from '../file/fileTypes.js';
import type { GitDiffResult } from '../git/gitDiffHandle.js';
import type { GitLogResult } from '../git/gitLogHandle.js';
import { calculateOutputMetrics } from '../metrics/calculateOutputMetrics.js';
import type { TokenCountTask } from '../metrics/workers/calculateMetricsWorker.js';
import { generateOutput } from './outputGenerate.js';

export interface OutputSplitGroup {
  rootEntry: string;
  processedFiles: ProcessedFile[];
  allFilePaths: string[];
}

export interface OutputSplitPart {
  index: number;
  filePath: string;
  content: string;
  byteLength: number;
  tokenCount: number;
  groups?: OutputSplitGroup[];
}

export type GenerateOutputFn = typeof generateOutput;

export const getRootEntry = (relativeFilePath: string): string => {
  const normalized = relativeFilePath.replaceAll(path.win32.sep, path.posix.sep);
  const [first] = normalized.split('/');
  return first || normalized;
};

export const buildOutputSplitGroups = (processedFiles: ProcessedFile[], allFilePaths: string[]): OutputSplitGroup[] => {
  const groupsByRootEntry = new Map<string, OutputSplitGroup>();

  for (const filePath of allFilePaths) {
    const rootEntry = getRootEntry(filePath);
    const existing = groupsByRootEntry.get(rootEntry);
    if (existing) {
      existing.allFilePaths.push(filePath);
    } else {
      groupsByRootEntry.set(rootEntry, { rootEntry, processedFiles: [], allFilePaths: [filePath] });
    }
  }

  for (const processedFile of processedFiles) {
    const rootEntry = getRootEntry(processedFile.path);
    const existing = groupsByRootEntry.get(rootEntry);
    if (existing) {
      existing.processedFiles.push(processedFile);
    } else {
      groupsByRootEntry.set(rootEntry, {
        rootEntry,
        processedFiles: [processedFile],
        allFilePaths: [processedFile.path],
      });
    }
  }

  return [...groupsByRootEntry.values()].sort((a, b) => a.rootEntry.localeCompare(b.rootEntry));
};

export const buildSplitOutputFilePath = (baseFilePath: string, partIndex: number): string => {
  const ext = path.extname(baseFilePath);
  if (!ext) {
    return `${baseFilePath}.${partIndex}`;
  }
  const baseWithoutExt = baseFilePath.slice(0, -ext.length);
  return `${baseWithoutExt}.${partIndex}${ext}`;
};

const getUtf8ByteLength = (content: string): number => Buffer.byteLength(content, 'utf8');

const makeChunkConfig = (baseConfig: RepomixConfigMerged, partIndex: number): RepomixConfigMerged => {
  if (partIndex === 1) {
    return baseConfig;
  }

  // For non-first chunks, disable git diffs/logs to avoid repeating large sections.
  const git = {
    ...baseConfig.output.git,
    includeDiffs: false,
    includeLogs: false,
  };

  return {
    ...baseConfig,
    output: {
      ...baseConfig.output,
      git,
    },
  };
};

const renderFiles = async (
  processedFiles: ProcessedFile[],
  allFilePaths: string[],
  partIndex: number,
  rootDirs: string[],
  baseConfig: RepomixConfigMerged,
  gitDiffResult: GitDiffResult | undefined,
  gitLogResult: GitLogResult | undefined,
  generateOutputFn: GenerateOutputFn,
  splitInfo?: {
    partNumber: number;
    totalParts: number;
    totalFiles: number;
  },
): Promise<string> => {
  const chunkConfig = makeChunkConfig(baseConfig, partIndex);

  return await generateOutputFn(
    rootDirs,
    chunkConfig,
    processedFiles,
    allFilePaths,
    partIndex === 1 ? gitDiffResult : undefined,
    partIndex === 1 ? gitLogResult : undefined,
    splitInfo,
  );
};

export const generateSplitOutputParts = async ({
  rootDirs,
  baseConfig,
  processedFiles,
  allFilePaths,
  maxBytesPerPart,
  maxTokensPerPart,
  gitDiffResult,
  gitLogResult,
  progressCallback,
  deps,
}: {
  rootDirs: string[];
  baseConfig: RepomixConfigMerged;
  processedFiles: ProcessedFile[];
  allFilePaths: string[];
  maxBytesPerPart?: number;
  maxTokensPerPart?: number;
  gitDiffResult: GitDiffResult | undefined;
  gitLogResult: GitLogResult | undefined;
  progressCallback: RepomixProgressCallback;
  deps: {
    generateOutput: GenerateOutputFn;
  };
}): Promise<OutputSplitPart[]> => {
  if (maxBytesPerPart !== undefined && (!Number.isSafeInteger(maxBytesPerPart) || maxBytesPerPart <= 0)) {
    throw new RepomixError(`Invalid maxBytesPerPart: ${maxBytesPerPart}`);
  }
  if (maxTokensPerPart !== undefined && (!Number.isSafeInteger(maxTokensPerPart) || maxTokensPerPart <= 0)) {
    throw new RepomixError(`Invalid maxTokensPerPart: ${maxTokensPerPart}`);
  }

  if (maxTokensPerPart !== undefined) {
    return await generateSplitOutputPartsByTokens({
      rootDirs,
      baseConfig,
      processedFiles,
      allFilePaths,
      maxTokensPerPart,
      gitDiffResult,
      gitLogResult,
      progressCallback,
      deps,
    });
  }

  if (maxBytesPerPart !== undefined) {
    return await generateSplitOutputPartsByBytes({
      rootDirs,
      baseConfig,
      processedFiles,
      allFilePaths,
      maxBytesPerPart,
      gitDiffResult,
      gitLogResult,
      progressCallback,
      deps,
    });
  }

  return [];
};

const generateSplitOutputPartsByBytes = async ({
  rootDirs,
  baseConfig,
  processedFiles,
  allFilePaths,
  maxBytesPerPart,
  gitDiffResult,
  gitLogResult,
  progressCallback,
  deps,
}: {
  rootDirs: string[];
  baseConfig: RepomixConfigMerged;
  processedFiles: ProcessedFile[];
  allFilePaths: string[];
  maxBytesPerPart: number;
  gitDiffResult: GitDiffResult | undefined;
  gitLogResult: GitLogResult | undefined;
  progressCallback: RepomixProgressCallback;
  deps: {
    generateOutput: GenerateOutputFn;
  };
}): Promise<OutputSplitPart[]> => {
  const groups = buildOutputSplitGroups(processedFiles, allFilePaths);
  if (groups.length === 0) {
    return [];
  }

  const parts: OutputSplitPart[] = [];
  let currentGroups: OutputSplitGroup[] = [];
  let currentContent = '';
  let currentBytes = 0;

  for (const group of groups) {
    const partIndex = parts.length + 1;
    const nextGroups = [...currentGroups, group];
    progressCallback(`Generating output... (part ${partIndex}) ${pc.dim(`evaluating ${group.rootEntry}`)}`);
    const nextContent = await renderFiles(
      nextGroups.flatMap((g) => g.processedFiles),
      allFilePaths,
      partIndex,
      rootDirs,
      baseConfig,
      gitDiffResult,
      gitLogResult,
      deps.generateOutput,
      {
        partNumber: partIndex,
        totalParts: groups.length,
        totalFiles: allFilePaths.length,
      },
    );
    const nextBytes = getUtf8ByteLength(nextContent);

    if (nextBytes <= maxBytesPerPart) {
      currentGroups = nextGroups;
      currentContent = nextContent;
      currentBytes = nextBytes;
      continue;
    }

    if (currentGroups.length === 0) {
      throw new RepomixError(
        `Cannot split output: root entry '${group.rootEntry}' exceeds max size. ` +
          `Part size ${nextBytes.toLocaleString()} bytes > limit ${maxBytesPerPart.toLocaleString()} bytes.`,
      );
    }

    parts.push({
      index: partIndex,
      filePath: buildSplitOutputFilePath(baseConfig.output.filePath, partIndex),
      content: currentContent,
      byteLength: currentBytes,
      tokenCount: 0, // Not calculated for byte-based split
      groups: currentGroups,
    });

    const newPartIndex = parts.length + 1;
    progressCallback(`Generating output... (part ${newPartIndex}) ${pc.dim(`evaluating ${group.rootEntry}`)}`);
    const singleGroupContent = await renderFiles(
      group.processedFiles,
      allFilePaths,
      newPartIndex,
      rootDirs,
      baseConfig,
      gitDiffResult,
      gitLogResult,
      deps.generateOutput,
      {
        partNumber: newPartIndex,
        totalParts: groups.length,
        totalFiles: allFilePaths.length,
      },
    );
    const singleGroupBytes = getUtf8ByteLength(singleGroupContent);
    if (singleGroupBytes > maxBytesPerPart) {
      throw new RepomixError(
        `Cannot split output: root entry '${group.rootEntry}' exceeds max size. ` +
          `Part size ${singleGroupBytes.toLocaleString()} bytes > limit ${maxBytesPerPart.toLocaleString()} bytes.`,
      );
    }

    currentGroups = [group];
    currentContent = singleGroupContent;
    currentBytes = singleGroupBytes;
  }

  if (currentGroups.length > 0) {
    const finalIndex = parts.length + 1;
    parts.push({
      index: finalIndex,
      filePath: buildSplitOutputFilePath(baseConfig.output.filePath, finalIndex),
      content: currentContent,
      byteLength: currentBytes,
      tokenCount: 0,
      groups: currentGroups,
    });
  }

  return parts;
};

const generateSplitOutputPartsByTokens = async ({
  rootDirs,
  baseConfig,
  processedFiles,
  allFilePaths,
  maxTokensPerPart,
  gitDiffResult,
  gitLogResult,
  progressCallback,
  deps,
}: {
  rootDirs: string[];
  baseConfig: RepomixConfigMerged;
  processedFiles: ProcessedFile[];
  allFilePaths: string[];
  maxTokensPerPart: number;
  gitDiffResult: GitDiffResult | undefined;
  gitLogResult: GitLogResult | undefined;
  progressCallback: RepomixProgressCallback;
  deps: {
    generateOutput: GenerateOutputFn;
  };
}): Promise<OutputSplitPart[]> => {
  const taskRunner = initTaskRunner<TokenCountTask, number>({
    numOfTasks: 1,
    workerPath: new URL('../metrics/workers/calculateMetricsWorker.js', import.meta.url).href,
    runtime: 'worker_threads',
  });

  try {
    const encoding = baseConfig.tokenCount.encoding as TiktokenEncoding;

    // 1. Pre-calculate tokens for each file (Parallelized via worker pool if many files)
    progressCallback('Pre-calculating file tokens...');
    const fileTokenCounts = await Promise.all(
      processedFiles.map(async (file) => {
        const count = await taskRunner.run({
          content: file.content,
          encoding,
          path: file.path,
        });
        return { path: file.path, count };
      }),
    );
    const tokenMap = new Map(fileTokenCounts.map((f) => [f.path, f.count]));

    const partFileData: ProcessedFile[][] = [];
    let currentFiles: ProcessedFile[] = [];
    let currentTokens = 0;

    // Estimation constant for overhead (XML tags, headers, etc.)
    const overheadPerFile = 20;

    for (const file of processedFiles) {
      const fileTokens = (tokenMap.get(file.path) || 0) + overheadPerFile;

      if (fileTokens > maxTokensPerPart) {
        if (currentFiles.length > 0) {
          partFileData.push(currentFiles);
          currentFiles = [];
          currentTokens = 0;
        }
        partFileData.push([file]);
        continue;
      }

      if (currentTokens + fileTokens > maxTokensPerPart) {
        partFileData.push(currentFiles);
        currentFiles = [file];
        currentTokens = fileTokens;
      } else {
        currentFiles.push(file);
        currentTokens += fileTokens;
      }
    }

    if (currentFiles.length > 0) {
      partFileData.push(currentFiles);
    }

    const totalParts = partFileData.length;
    const parts: OutputSplitPart[] = [];

    for (let i = 0; i < totalParts; i++) {
      const files = partFileData[i];
      const partIndex = i + 1;
      const content = await renderFiles(
        files,
        allFilePaths,
        partIndex,
        rootDirs,
        baseConfig,
        gitDiffResult,
        gitLogResult,
        deps.generateOutput,
        {
          partNumber: partIndex,
          totalParts,
          totalFiles: allFilePaths.length,
        },
      );

      const tokenCount = await calculateOutputMetrics(content, encoding, undefined, { taskRunner });
      if (files.length === 1 && tokenCount > maxTokensPerPart) {
        throw new RepomixError(
          `Cannot split output: file '${files[0].path}' exceeds max tokens. ` +
            `Tokens ${tokenCount.toLocaleString()} > limit ${maxTokensPerPart.toLocaleString()}.`,
        );
      }

      parts.push({
        index: partIndex,
        filePath: buildSplitOutputFilePath(baseConfig.output.filePath, partIndex),
        content,
        byteLength: getUtf8ByteLength(content),
        tokenCount,
      });
    }

    return parts;
  } finally {
    await taskRunner.cleanup();
  }
};
