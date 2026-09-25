import type { ThemeRegistrationRaw } from 'shiki';

/**
 * Instrument Shiki themes: graphite text with the site's one signal hue. Keywords are amber, like the lit
 * controls on a panel; function names are full-contrast ink; strings and numbers sit one step back, punctuation
 * two, and comments are italic at the lightest readable graphite. Used by MDX code blocks (source.config.ts) and
 * the landing page.
 */
function instrument(type: 'light' | 'dark'): ThemeRegistrationRaw {
  const light = type === 'light';
  const tone = light
    ? {
        fg: '#17191d',
        strong: '#bd5006',
        ink: '#0b0c0f',
        string: '#4b515a',
        literal: '#933f0b',
        type: '#22262c',
        punctuation: '#6d747e',
        comment: '#8a919b',
        bg: '#ffffff',
      }
    : {
        fg: '#e0e3e7',
        strong: '#ff9838',
        ink: '#f7f8f9',
        string: '#aab0b8',
        literal: '#ffcf9e',
        type: '#eff1f3',
        punctuation: '#7a818b',
        comment: '#5f666f',
        bg: '#101215',
      };

  return {
    name: `better-compute-instrument-${type}`,
    type,
    colors: {
      'editor.background': tone.bg,
      'editor.foreground': tone.fg,
    },
    settings: [
      { settings: { foreground: tone.fg, background: tone.bg } },
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: tone.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.operator.new',
          'keyword.operator.expression',
          'keyword.control',
          'variable.language',
          'constant.language.boolean',
          'constant.language.null',
          'constant.language.undefined',
        ],
        settings: { foreground: tone.strong },
      },
      {
        scope: [
          'string',
          'string.quoted',
          'string.template',
          'punctuation.definition.string',
          'markup.inline.raw',
        ],
        settings: { foreground: tone.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: tone.literal },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call entity.name.function',
          'entity.name.tag',
        ],
        settings: { foreground: tone.ink, fontStyle: 'bold' },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
          'entity.other.inherited-class',
          'entity.name.namespace',
        ],
        settings: { foreground: tone.type, fontStyle: 'italic' },
      },
      {
        scope: [
          'variable',
          'variable.other',
          'variable.parameter',
          'meta.object-literal.key',
          'support.type.property-name',
          'entity.other.attribute-name',
        ],
        settings: { foreground: tone.fg },
      },
      {
        scope: [
          'punctuation',
          'meta.brace',
          'keyword.operator',
          'punctuation.separator',
          'punctuation.terminator',
          'meta.delimiter',
        ],
        settings: { foreground: tone.punctuation },
      },
      { scope: ['markup.heading', 'markup.bold'], settings: { fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
      { scope: ['markup.inserted'], settings: { foreground: tone.ink } },
      {
        scope: ['markup.deleted'],
        settings: { foreground: tone.comment, fontStyle: 'strikethrough' },
      },
    ],
  };
}

export const codeThemes = {
  light: instrument('light'),
  dark: instrument('dark'),
};
