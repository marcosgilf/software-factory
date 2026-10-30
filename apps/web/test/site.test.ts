import { describe, expect, it } from 'vitest';
import { site } from '../src/lib/site.js';

describe('web app shell', () => {
  it('has a title and description for the Astro home page', () => {
    expect(site.title).toBe('Software Factory');
    expect(site.description.length).toBeGreaterThan(0);
  });
});
