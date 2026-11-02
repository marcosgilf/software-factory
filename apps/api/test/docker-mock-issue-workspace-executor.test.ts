import { describe, expect, it } from 'vitest';
import {
  assertDockerOperationKey,
  assertLocalDockerEndpoint,
  buildDockerEnvironment,
  buildDockerRunArgs,
} from '../src/docker-mock-issue-workspace-executor.js';

describe('Docker mock workspace executor', () => {
  it('runs as a constrained non-root container with only workspace mounted', () => {
    const args = buildDockerRunArgs(
      '/tmp/factory-workspace',
      'factory-issue-test',
      501,
      20,
      'unix:///var/run/docker.sock',
    );

    expect(args).toContain('--host');
    expect(args).toContain('unix:///var/run/docker.sock');
    expect(args).toContain('--network=none');
    expect(args).toContain('--user');
    expect(args).toContain('501:20');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges:true');
    expect(args).toContain('--pids-limit=64');
    expect(args).toContain('--memory=256m');
    expect(args).toContain('--cpus=1');
    expect(args.filter((argument) => argument.startsWith('type=bind,'))).toEqual([
      'type=bind,src=/tmp/factory-workspace,dst=/workspace',
    ]);
    expect(args).not.toContain('--privileged');
  });

  it('only accepts generated UUID operation keys', () => {
    assertDockerOperationKey('bffb9070-e1aa-46c1-8c37-684548811c16');
    expect(() => assertDockerOperationKey('../outside')).toThrow(
      'Docker workspace operation key is invalid.',
    );
  });

  it('rejects remote Docker endpoints', () => {
    assertLocalDockerEndpoint('unix:///var/run/docker.sock');
    expect(() => assertLocalDockerEndpoint('tcp://docker.example.com:2376')).toThrow(
      'Docker workspace requires a local Unix socket.',
    );
    expect(() => assertLocalDockerEndpoint('ssh://docker.example.com')).toThrow();
  });

  it('does not pass backend or GitHub credentials to the Docker CLI environment', () => {
    expect(
      buildDockerEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/factory',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        FACTORY_API_TOKEN: 'device-token',
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'github-token',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/factory',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    });
  });
});
