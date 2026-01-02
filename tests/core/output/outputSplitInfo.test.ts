import { describe, expect, it, vi } from 'vitest';
import { generateSplitOutputParts } from '../../../src/core/output/outputSplit.js';
import { generateHeader, generateSummaryPurpose } from '../../../src/core/output/outputStyleDecorate.js';

describe('outputSplit integration with splitInfo', () => {
  const createMockConfig = () =>
    ({
      output: {
        filePath: 'repomix-output.xml',
        style: 'xml',
        parsableStyle: true,
        directoryStructure: true,
        removeComments: false,
        removeEmptyLines: false,
        showLineNumbers: false,
        compress: false,
        truncateBase64: false,
        git: {
          includeDiffs: false,
          includeLogs: false,
        },
      },
      include: [],
      ignore: {
        customPatterns: [],
        useGitignore: true,
        useDefaultPatterns: true,
      },
      security: {
        enableSecurityCheck: true,
      },
      tokenCount: {
        encoding: 'o200k_base',
      },
    }) as any;

  it('passes correct splitInfo to generateOutput', async () => {
    const processedFiles = [
      { path: 'src/a.ts', content: 'source a' },
      { path: 'tests/test.ts', content: 'test content' },
    ];
    const allFilePaths = ['src/a.ts', 'tests/test.ts'];

    const mockGenerateOutput = vi.fn().mockImplementation(async (_rootDirs, _config, files) => {
      // Return a string whose length is easily controlled
      return 'x'.repeat(files.length * 50);
    });

    // Each file belongs to a different group (src/ tests/). 
    // Group 1 (src/a.ts) -> length 50.
    // Group 1+2 (src/a.ts, tests/test.ts) -> length 100.
    
    const resultSplit = await generateSplitOutputParts({
      rootDirs: ['/test'],
      baseConfig: createMockConfig(),
      processedFiles,
      allFilePaths,
      maxBytesPerPart: 70, // src/a.ts (50) fits, but adding tests/test.ts (100) doesn't
      gitDiffResult: undefined,
      gitLogResult: undefined,
      progressCallback: () => {},
      deps: { generateOutput: mockGenerateOutput },
    });

    expect(resultSplit.length).toBe(2);

    // Verify calls to generateOutput
    // It should be called for part 1, and then for part 2
    expect(mockGenerateOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      allFilePaths,
      undefined,
      undefined,
      expect.objectContaining({
        partNumber: expect.any(Number),
        totalParts: expect.any(Number),
        totalFiles: allFilePaths.length,
      }),
    );
    
    // Check totalParts in last call
    const calls = mockGenerateOutput.mock.calls;
    const lastCallSplitInfo = calls[calls.length - 1][6];
    expect(lastCallSplitInfo.totalParts).toBeGreaterThan(0);
  });
});

describe('outputStyleDecorate with splitInfo', () => {
  const createConfig = () => ({
    include: [],
    ignore: { customPatterns: [], useGitignore: true, useDefaultPatterns: true },
    output: {
      style: 'xml',
      removeComments: false,
      removeEmptyLines: false,
      showLineNumbers: false,
      parsableStyle: false,
      compress: false,
      truncateBase64: false,
    },
    security: { enableSecurityCheck: true },
  } as any);

  it('generates header with split information', () => {
    const splitInfo = {
      partNumber: 2,
      totalParts: 5,
      totalPartFiles: 10,
      totalFiles: 50,
    };
    const header = generateHeader(createConfig(), '2025-01-01', splitInfo);
    expect(header).toContain('This file is part 2 of 5 of a split representation of the entire codebase.');
    expect(header).toContain('This file contains 10 out of a total of 50 files.');
  });

  it('generates summary purpose with split information', () => {
    const splitInfo = {
      partNumber: 2,
      totalParts: 5,
      totalPartFiles: 10,
      totalFiles: 50,
    };
    const purpose = generateSummaryPurpose(createConfig(), splitInfo);
    expect(purpose).toContain('part 2 of 5 of the entire repository\'s contents (10/50 files)');
  });
});
