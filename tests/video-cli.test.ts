import { describe, expect, it } from 'vitest';
import { createVideoCommand } from '../src/cli/video.js';

describe('Video CLI Command', () => {
  const cmd = createVideoCommand();

  it('should have correct command name', () => {
    expect(cmd.name()).toBe('video');
  });

  it('should have a description', () => {
    expect(cmd.description()).toContain('video');
  });

  it('should require a prompt option', () => {
    const promptOpt = cmd.options.find((o) => o.long === '--prompt');
    expect(promptOpt).toBeDefined();
    expect(promptOpt?.required).toBe(true);
  });

  it('should have a mode option with default "ingredients"', () => {
    const modeOpt = cmd.options.find((o) => o.long === '--mode');
    expect(modeOpt).toBeDefined();
    expect(modeOpt?.defaultValue).toBe('ingredients');
  });

  it('should have model, orientation, and count options', () => {
    const modelOpt = cmd.options.find((o) => o.long === '--model');
    const orientOpt = cmd.options.find((o) => o.long === '--orientation');
    const countOpt = cmd.options.find((o) => o.long === '--count');
    expect(modelOpt).toBeDefined();
    expect(orientOpt).toBeDefined();
    expect(countOpt).toBeDefined();
  });

  it('should have keyframe options for frames mode', () => {
    const startOpt = cmd.options.find((o) => o.long === '--start-frame');
    const endOpt = cmd.options.find((o) => o.long === '--end-frame');
    expect(startOpt).toBeDefined();
    expect(endOpt).toBeDefined();
  });

  it('should have headed and timeout options', () => {
    const headedOpt = cmd.options.find((o) => o.long === '--headed');
    const timeoutOpt = cmd.options.find((o) => o.long === '--timeout');
    expect(headedOpt).toBeDefined();
    expect(timeoutOpt).toBeDefined();
  });

  it('should have save-dir option for output directory', () => {
    const saveDirOpt = cmd.options.find((o) => o.long === '--save-dir');
    expect(saveDirOpt).toBeDefined();
  });

  it('should have isolated-profile option', () => {
    const isoOpt = cmd.options.find((o) => o.long === '--isolated-profile');
    expect(isoOpt).toBeDefined();
  });

  it('should have a provider option defaulting to flow', () => {
    const providerOpt = cmd.options.find((o) => o.long === '--provider');
    expect(providerOpt).toBeDefined();
    expect(providerOpt?.defaultValue).toBe('flow');
  });

  it('should have Dreamina-specific options', () => {
    for (const long of ['--aspect', '--resolution', '--duration', '--ref-mode', '--image']) {
      expect(cmd.options.find((o) => o.long === long)).toBeDefined();
    }
  });

  it('should collect repeatable --image into an array (default empty)', () => {
    const imageOpt = cmd.options.find((o) => o.long === '--image');
    expect(imageOpt).toBeDefined();
    expect(imageOpt?.defaultValue).toEqual([]);
  });
});
