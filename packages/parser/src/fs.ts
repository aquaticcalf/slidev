import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { slash } from '@antfu/utils'
import type {
  PreparserExtensionLoader,
  SlideInfo,
  SlidevData,
  SlidevMarkdown,
  SlidevPreparserExtension,
  SourceSlideInfo,
} from '@slidev/types'
import YAML from 'yaml'
import { detectFeatures, parse, parseRangeString, stringify } from './core'

export * from './core'

let preparserExtensionLoader: PreparserExtensionLoader | null = null

export function injectPreparserExtensionLoader(fn: PreparserExtensionLoader) {
  preparserExtensionLoader = fn
}

/**
 * Slidev data without config and themeMeta,
 * because config and themeMeta depends on the theme to be loaded.
 */
export type LoadedSlidevData = Omit<SlidevData, 'config' | 'themeMeta'>

export async function load(
  userRoot: string,
  filepath: string,
  sources: Record<string, string> | ((path: string) => Promise<string>) = {},
  mode?: string,
): Promise<LoadedSlidevData> {
  const loadSource =
    typeof sources === 'function'
      ? sources
      : async (path: string) => {
          if (sources[path]) return sources[path]
          if (/^https?:\/\//.test(path)) {
            const { ofetch } = await import('ofetch')
            return await ofetch(path, { responseType: 'text' })
          }
          return readFile(path, 'utf-8')
        }

  const markdown = await loadSource(filepath)

  let extensions: SlidevPreparserExtension[] | undefined
  if (preparserExtensionLoader) {
    // #703
    // identify the headmatter, to be able to load preparser extensions
    // (strict parsing based on the parsing code)
    const lines = markdown.split(/\r?\n/g)
    let hm = ''
    if (lines[0].match(/^---([^-].*)?$/) && !lines[1]?.match(/^\s*$/)) {
      let hEnd = 1
      while (hEnd < lines.length && !lines[hEnd].trimEnd().match(/^---$/))
        hEnd++
      hm = lines.slice(1, hEnd).join('\n')
    }
    const o = (YAML.parse(hm) as Record<string, unknown>) ?? {}
    extensions = await preparserExtensionLoader(o, filepath, mode)
  }

  const markdownFiles: Record<string, SlidevMarkdown> = {}
  const watchFiles: Record<string, Set<number>> = {}
  const slides: SlideInfo[] = []

  async function loadMarkdown(
    path: string,
    range?: string,
    frontmatterOverride?: Record<string, unknown>,
    importers?: SourceSlideInfo[],
  ) {
    let md = markdownFiles[path]
    if (!md) {
      const raw = await loadSource(path)
      md = await parse(raw, path, extensions)
      markdownFiles[path] = md
      watchFiles[path] = new Set()
    }

    const directImporter = importers?.at(-1)
    for (const index of parseRangeString(md.slides.length, range)) {
      const subSlide = md.slides[index - 1]
      try {
        await loadSlide(md, subSlide, frontmatterOverride, importers)
      } catch (e) {
        md.errors ??= []
        md.errors.push({
          row: subSlide.start,
          message: `Error when loading slide: ${e}`,
        })
        continue
      }
      if (directImporter) {
        directImporter.imports ??= []
        directImporter.imports.push(subSlide)
      }
    }

    return md
  }

  async function loadSlide(
    md: SlidevMarkdown,
    slide: SourceSlideInfo,
    frontmatterOverride?: Record<string, unknown>,
    importChain?: SourceSlideInfo[],
  ) {
    if (slide.frontmatter.disabled || slide.frontmatter.hide) return
    if (slide.frontmatter.src) {
      const [rawPath, rangeRaw] = slide.frontmatter.src.split('#')
      let path: string
      if (/^https?:\/\//.test(rawPath)) {
        path = rawPath
      } else {
        path = slash(
          rawPath.startsWith('/')
            ? resolve(userRoot, rawPath.substring(1))
            : resolve(dirname(slide.filepath), rawPath),
        )
      }

      const mergedFrontmatter = {
        ...slide.frontmatter,
        ...frontmatterOverride,
      }
      delete mergedFrontmatter.src

      if (!/^https?:\/\//.test(path) && !existsSync(path)) {
        md.errors ??= []
        md.errors.push({
          row: slide.start,
          message: `Imported markdown file not found: ${path}`,
        })
      } else {
        await loadMarkdown(
          path,
          rangeRaw,
          mergedFrontmatter,
          importChain ? [...importChain, slide] : [slide],
        )
      }
    } else {
      slides.push({
        frontmatter: { ...slide.frontmatter, ...frontmatterOverride },
        content: slide.content,
        revision: slide.revision,
        frontmatterRaw: slide.frontmatterRaw,
        note: slide.note,
        title: slide.title,
        level: slide.level,
        index: slides.length,
        importChain,
        source: slide,
      })
    }
  }

  const entry = await loadMarkdown(slash(filepath))

  const headmatter = { ...entry.slides[0]?.frontmatter }
  if (slides[0]?.title) {
    headmatter.title ??= slides[0].title
  }

  return {
    slides,
    entry,
    headmatter,
    features: detectFeatures(slides.map((s) => s.source.raw).join('')),
    markdownFiles,
    watchFiles,
  }
}

export async function save(markdown: SlidevMarkdown) {
  if (/^https?:\/\//.test(markdown.filepath)) return stringify(markdown)
  const fileContent = stringify(markdown)
  await writeFile(markdown.filepath, fileContent, 'utf-8')
  return fileContent
}
