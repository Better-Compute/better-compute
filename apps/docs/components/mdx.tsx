import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import * as Twoslash from 'fumadocs-twoslash/ui';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { Callout } from '@/components/docs/callout';
import { Card, Cards } from '@/components/docs/card';
import { Mermaid } from '@/components/mermaid';
import { ApiEndpoint, ApiGroupSummary } from '@/components/api-reference';
import { FeatureGrid, Feature } from '@/components/feature-grid';
import { Glossary } from '@/components/glossary';
import { PackageTable } from '@/components/package-table';
import { PackageGraph } from '@/components/package-graph';
import { Term } from '@/components/term';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Twoslash popups, for any snippet marked `twoslash` (the content does not use it today).
    ...Twoslash,
    // BoardUI-styled replacements for Fumadocs' defaults (components/docs).
    Callout,
    Card,
    Cards,
    img: (props: ComponentProps<'img'>) => (
      <ImageZoom {...(props as ComponentProps<typeof ImageZoom>)} />
    ),
    Tabs,
    Tab,
    Steps,
    Step,
    Accordion,
    Accordions,
    Files,
    Folder,
    File,
    TypeTable,
    Mermaid,
    ApiEndpoint,
    ApiGroupSummary,
    FeatureGrid,
    Feature,
    Glossary,
    PackageTable,
    PackageGraph,
    Term,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
