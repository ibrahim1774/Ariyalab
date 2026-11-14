// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import Button from '../../components/ui/Button';
import Accordion from '../../components/ui/Accordion';
import Stepper from '../../components/ui/Stepper';

afterEach(cleanup);

describe('Button', () => {
  it('renders an arrow after the label', () => {
    render(<Button>Get started</Button>);
    const btn = screen.getByRole('button', { name: /get started/i });
    expect(btn.querySelector('[data-arrow]')).not.toBeNull();
  });

  it.each(['primary', 'ghost', 'dark'])('supports variant %s', (variant) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', variant);
  });

  it('defaults to primary', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'primary');
  });
});

describe('Accordion', () => {
  const items = [
    { id: 'a', title: 'First', body: 'Body A' },
    { id: 'b', title: 'Second', body: 'Body B' },
  ];

  it('opens one item at a time', () => {
    render(<Accordion items={items} />);
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    expect(first).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Stepper', () => {
  it('marks steps done, current and stale', () => {
    render(
      <Stepper
        steps={[
          { id: 's1', label: 'Story' },
          { id: 's2', label: 'Cast' },
          { id: 's3', label: 'Frames', stale: true },
          { id: 's4', label: 'Video' },
        ]}
        currentId="s2"
      />,
    );
    const state = (name) => screen.getByText(name).closest('li').getAttribute('data-state');
    expect(state('Story')).toBe('done');
    expect(state('Cast')).toBe('current');
    expect(state('Frames')).toBe('stale');
    expect(state('Video')).toBe('upcoming');
  });
});
