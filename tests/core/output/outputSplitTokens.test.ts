import { describe, expect, it, vi } from 'vitest';
import { generateSplitOutputParts } from '../../../src/core/output/outputSplit.js';

vi.mock('../../../src/core/metrics/calculateOutputMetrics.js', () => ({
  calculateOutputMetrics: vi.fn(),
}));

vi.mock('../../../src/shared/processConcurrency.js', () => ({
  initTaskRunner: vi.fn(() => ({
    run: vi.fn().mockImplementation(async (task) => {
      // Return 60 for any file token count task
      if (task.path && task.path.endsWith('.ts')) {
        return 60;
      }
      // fallback for calculateOutputMetrics if used via taskRunner
      return 60;
    }),
    cleanup: vi.fn(),
  })),
}));

import { calculateOutputMetrics } from '../../../src/core/metrics/calculateOutputMetrics.js';

describe('outputSplit token-based', () => {
  const createMockConfig = () =>
    ({
      output: {
        filePath: 'repomix-output.xml',
        git: {
          includeDiffs: false,
          includeLogs: false,
        },
      },
      tokenCount: {
        encoding: 'o200k_base',
      },
    }) as any;

  it('successfully splits output into multiple parts when tokens exceed limit', async () => {
    const processedFiles = [
      { path: 'file1.ts', content: 'content1' },
      { path: 'file2.ts', content: 'content2' },
      { path: 'file3.ts', content: 'content3' },
    ];
    const allFilePaths = ['file1.ts', 'file2.ts', 'file3.ts'];

    // calculateOutputMetrics is used for the FINAL content of each part
    (calculateOutputMetrics as any).mockResolvedValue(60);

    const mockGenerateOutput = async (_rootDirs: string[], _config: any, files: any[]) => {
      return files.map((f) => f.path).join(',');
    };

    const result = await generateSplitOutputParts({
      rootDirs: ['/test'],
      baseConfig: createMockConfig(),
      processedFiles,
      allFilePaths,
      maxTokensPerPart: 100, // Each file is 60 (+20 overhead) = 80. file1+file2 = 160 > 100
      gitDiffResult: undefined,
      gitLogResult: undefined,
      progressCallback: () => {},
      deps: { generateOutput: mockGenerateOutput as any },
    });

    expect(result.length).toBe(3);
    expect(result[0].content).toBe('file1.ts');
    expect(result[1].content).toBe('file2.ts');
    expect(result[2].content).toBe('file3.ts');
  });

  it('throws error when a single file exceeds maxTokensPerPart', async () => {
    const processedFiles = [{ path: 'large.ts', content: 'large content' }];
    const allFilePaths = ['large.ts'];

    // Mock final content token count
    (calculateOutputMetrics as any).mockResolvedValue(200);
    
    // Also need to make sure the pre-calculation exceeds limit
    const { initTaskRunner } = await import('../../../src/shared/processConcurrency.js');
    (initTaskRunner as any).mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue(150), // 150 + 20 overhead = 170 > 100
      cleanup: vi.fn(),
    }));

    await expect(
      generateSplitOutputParts({
        rootDirs: ['/test'],
        baseConfig: createMockConfig(),
        processedFiles,
        allFilePaths,
        maxTokensPerPart: 100,
        gitDiffResult: undefined,
        gitLogResult: undefined,
        progressCallback: () => {},
        deps: { generateOutput: async () => 'large.ts' },
      }),
    ).rejects.toThrow(/exceeds max tokens/);
  });
});
