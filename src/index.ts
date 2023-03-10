import { ConfigurationChief } from './configuration-chief.js';
import { ConsoleStreamer } from './console-streamer.js';
import { ROOT_WORKSPACE_NAME, DEFAULT_EXTENSIONS } from './constants.js';
import { DependencyDeputy } from './dependency-deputy.js';
import { IssueCollector } from './issue-collector.js';
import { PrincipalFactory } from './principal-factory.js';
import { Exports, ImportedModule, Imports } from './types/ast.js';
import { compact } from './util/array.js';
import { debugLogObject, debugLogArray } from './util/debug.js';
import { findFile, loadJSON, findFileWithExtensions } from './util/fs.js';
import { _glob } from './util/glob.js';
import { join } from './util/path.js';
import { loadTSConfig } from './util/tsconfig-loader.js';
import { WorkspaceWorker } from './workspace-worker.js';
import type { CommandLineOptions } from './types/cli.js';

export type { RawConfiguration as KnipConfig } from './types/config.js';
export type { Reporter, ReporterOptions } from './types/issues.js';

export const main = async (unresolvedConfiguration: CommandLineOptions) => {
  const { cwd, tsConfigFile, gitignore, isStrict, isProduction, isShowProgress } = unresolvedConfiguration;

  const chief = new ConfigurationChief({ cwd, isProduction });

  debugLogObject('Unresolved configuration (from CLI arguments)', unresolvedConfiguration);

  const collector = new IssueCollector({ cwd });
  const console = new ConsoleStreamer({ isEnabled: isShowProgress });

  console.cast('Reading workspace configuration(s)...');

  await chief.loadLocalConfig();

  const deputy = new DependencyDeputy({ isStrict });

  const workspaces = chief.getActiveWorkspaces();

  debugLogObject('Included workspaces', workspaces);

  const report = chief.resolveIncludedIssueTypes();

  const compilers = chief.getCompilers();

  const enabledPluginsStore: Map<string, string[]> = new Map();

  collector.setReport(report);

  const factory = new PrincipalFactory();

  for (const workspace of workspaces) {
    const { name, dir, config, ancestors } = workspace;

    const isRoot = name === ROOT_WORKSPACE_NAME;

    const suffix = isRoot ? '' : ` (${name})`;

    const manifestPath = isRoot ? chief.manifestPath : findFile(dir, 'package.json');
    const manifest = isRoot ? chief.manifest : manifestPath && (await loadJSON(manifestPath));

    if (!manifestPath || !manifest) continue;

    const { ignoreDependencies } = chief.getConfigForWorkspace(name);

    deputy.addWorkspace({ name, dir, manifestPath, manifest, ignoreDependencies });

    const tsConfigFilePath = join(dir, tsConfigFile ?? 'tsconfig.json');
    const tsConfig = await loadTSConfig(tsConfigFilePath);

    const principal = factory.getPrincipal({
      cwd: dir,
      compilerOptions: tsConfig?.compilerOptions,
      paths: config.paths,
      report,
      compilers,
    });

    progress.updateMessage(`Resolving custom dependencies...${suffix}`);

    const workspaceManifest = deputy.getWorkspaceManifest(name);

    if (!workspaceManifest) continue;

    const negatedWorkspacePatterns = await chief.getNegatedWorkspacePatterns(name);

    const worker = new WorkspaceWorker({
      name,
      dir,
      config,
      rootWorkspaceConfig: chief.getConfigForWorkspace(ROOT_WORKSPACE_NAME),
      manifest,
      rootConfig: chief.config,
      negatedWorkspacePatterns,
      rootWorkspaceDir: cwd,
      isProduction,
    });

    const enabledPluginsInAncestors = ancestors.flatMap(ancestor => enabledPluginsStore.get(ancestor) ?? []);
    await worker.setEnabledPlugins(enabledPluginsInAncestors);

    await worker.initReferencedDependencies();

    progress.updateMessage(`Finding entry and project files${suffix}...`);
    const sharedGlobOptions = { cwd, workingDir: dir, gitignore, ignore: worker.getIgnorePatterns() };

    if (isProduction) {
      {
        const patterns = worker.getProductionEntryFilePatterns();
        const workspaceEntryPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found entry paths (${name})`, workspaceEntryPaths);
        principal.addEntryPaths(workspaceEntryPaths);
        principal.skipExportsAnalysisFor(workspaceEntryPaths);
      }

      {
        const patterns = worker.getProductionPluginEntryFilePatterns();
        const pluginWorkspaceEntryPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found production plugin entry paths (${name})`, pluginWorkspaceEntryPaths);
        principal.addEntryPaths(pluginWorkspaceEntryPaths);
        principal.skipExportsAnalysisFor(pluginWorkspaceEntryPaths);
      }

      {
        const patterns = worker.getProductionProjectFilePatterns();
        const workspaceProjectPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found project paths (${name})`, workspaceProjectPaths);
        workspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
      }
    } else {
      {
        const patterns = worker.getEntryFilePatterns();
        const workspaceEntryPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found entry paths (${name})`, workspaceEntryPaths);
        principal.addEntryPaths(workspaceEntryPaths);
        principal.skipExportsAnalysisFor(workspaceEntryPaths);
      }

      {
        const patterns = worker.getProjectFilePatterns();
        const workspaceProjectPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found project paths (${name})`, workspaceProjectPaths);
        workspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
      }

      {
        const patterns = worker.getPluginEntryFilePatterns();
        const pluginWorkspaceEntryPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found plugin entry paths (${name})`, pluginWorkspaceEntryPaths);
        principal.addEntryPaths(pluginWorkspaceEntryPaths);
        principal.skipExportsAnalysisFor(pluginWorkspaceEntryPaths);
      }

      {
        const patterns = worker.getPluginProjectFilePatterns();
        const pluginWorkspaceProjectPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found plugin project paths (${name})`, pluginWorkspaceProjectPaths);
        pluginWorkspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
        principal.skipExportsAnalysisFor(pluginWorkspaceProjectPaths);
      }

      {
        const patterns = compact(worker.getPluginConfigPatterns());
        const configurationEntryPaths = await _glob({ ...sharedGlobOptions, patterns });
        debugLogArray(`Found plugin configuration paths (${name})`, configurationEntryPaths);
        principal.addEntryPaths(configurationEntryPaths);
        principal.skipExportsAnalysisFor(configurationEntryPaths);
      }
    }

    // Add knip.ts (might import dependencies)
    if (chief.resolvedConfigFilePath) principal.addEntryPath(chief.resolvedConfigFilePath);

    // Get peerDependencies, installed binaries, entry files gathered through all plugins, and hand over
    // A bit of an entangled hotchpotch, but it's all related, and efficient in terms of reading package.json once, etc.
    const dependencies = await worker.findAllDependencies();
    const { referencedDependencies, peerDependencies, installedBinaries, entryFiles, enabledPlugins } = dependencies;

    deputy.addPeerDependencies(name, peerDependencies);
    deputy.setInstalledBinaries(name, installedBinaries);
    principal.addEntryPaths(entryFiles);
    enabledPluginsStore.set(name, enabledPlugins);

    referencedDependencies.forEach(([filePath, specifier]) => {
      const [isAdded, packageName] = deputy.maybeAddReferencedExternalDependency(workspace, specifier);
      if (!isAdded) {
        if (!ignoreDependencies.includes(specifier)) {
          collector.addIssue({ type: 'unlisted', filePath, symbol: specifier });
        }
      } else if (packageName && packageName !== specifier) {
        // A plugin's custom dependency resolver may return specifiers in the form of `@local/other-package/file`
        const workspace = chief.findWorkspaceByPackageName(packageName);
        if (workspace) {
          const relativeSpecifier = specifier.replace(new RegExp(`^${packageName}`), '.');
          const filePath = findFileWithExtensions(workspace.dir, relativeSpecifier, DEFAULT_EXTENSIONS);
          if (filePath) {
            principal.addEntryPath(filePath);
          }
        }
      }
    });
  }

  const principals = factory.getPrincipals();

  for (const principal of principals) {
    const exportedSymbols: Exports = new Map();
    const importedSymbols: Imports = new Map();

    const analyzeSourceFile = (filePath: string) => {
      collector.counters.processed++;
      const workspace = chief.findWorkspaceByFilePath(filePath);
      if (workspace) {
        const { imports, exports, duplicateExports } = principal.analyzeSourceFile(filePath);
        const { internal, external, unresolved } = imports;

        if (exports.size > 0) exportedSymbols.set(filePath, exports);

        for (const [specifierFilePath, importItems] of internal.entries()) {
          const importedWorkspace = chief.findWorkspaceByFilePath(specifierFilePath);
          if (importedWorkspace && importedWorkspace !== workspace) {
            external.add(importItems.specifier);
          }

          if (!importedSymbols.has(specifierFilePath)) {
            importedSymbols.set(specifierFilePath, importItems);
          } else {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const importedModule = importedSymbols.get(specifierFilePath)!;
            for (const identifier of importItems.symbols) {
              importedModule.symbols.add(identifier);
            }
            if (importItems.isReExported) {
              importedModule.isReExported = importItems.isReExported;
              importedModule.isReExportedBy.add(filePath);
            }
          }
        }

        duplicateExports.forEach(symbols => {
          const symbol = symbols.join('|');
          collector.addIssue({ type: 'duplicates', filePath, symbol, symbols });
        });

        external.forEach(specifier => {
          const [isAdded, packageName] = deputy.maybeAddReferencedExternalDependency(workspace, specifier);
          if (!isAdded && packageName) {
            collector.addIssue({ type: 'unlisted', filePath, symbol: specifier });
          }
        });

        unresolved.forEach(moduleSpecifier => {
          collector.addIssue({ type: 'unresolved', filePath, symbol: moduleSpecifier });
        });
      }
    };

    const isExportedInEntryFile = (importedModule?: ImportedModule): boolean => {
      if (!importedModule) return false;
      const { isReExported, isReExportedBy } = importedModule;
      const { entryPaths } = principal;
      const hasFile = (file: string) => entryPaths.has(file) || isExportedInEntryFile(importedSymbols.get(file));
      return isReExported ? Array.from(isReExportedBy).some(hasFile) : false;
    };

    console.cast('Running async compilers...');

    await principal.runAsyncCompilers();

    console.cast('Connecting the dots...');

    const analyzedFiles: Set<string> = new Set();
    let size = principal.entryPaths.size;
    let round = 0;

    do {
      size = principal.entryPaths.size;
      const resolvedFiles = principal.getUsedResolvedFiles();
      const files = resolvedFiles.filter(filePath => !analyzedFiles.has(filePath));

      debugLogArray(`Analyzing used resolved files [${++round}/${principals.indexOf(principal) + 1}]`, files);
      files.forEach(filePath => {
        analyzeSourceFile(filePath);
        analyzedFiles.add(filePath);
      });
    } while (size !== principal.entryPaths.size);

    const unusedFiles = principal.getUnreferencedFiles();

    collector.addFilesIssues(unusedFiles);

    collector.setTotalFileCount(analyzedFiles.size + unusedFiles.length);

    console.cast('Analyzing source files...');

    for (const [filePath, exportItems] of exportedSymbols.entries()) {
      const importedModule = importedSymbols.get(filePath);

      if (importedModule) {
        for (const [symbol, exportedItem] of exportItems.entries()) {
          // Leave exports with a JSDoc `@public` tag alone
          if (principal.isPublicExport(exportedItem)) continue;

          if (report.enumMembers && exportedItem.type === 'enum' && exportedItem.members) {
            principal.findUnusedMembers(filePath, exportedItem.members).forEach(member => {
              collector.addIssue({ type: 'enumMembers', filePath, symbol: member, parentSymbol: symbol });
            });
          }

          if (report.classMembers && exportedItem.type === 'class' && exportedItem.members) {
            principal.findUnusedMembers(filePath, exportedItem.members).forEach(member => {
              collector.addIssue({ type: 'classMembers', filePath, symbol: member, parentSymbol: symbol });
            });
          }

          if (importedModule.symbols.has(symbol)) continue;

          if (importedModule.isReExported || importedModule.isStar) {
            const isReExportedByEntryFile = isExportedInEntryFile(importedModule);
            if (!isReExportedByEntryFile && !principal.hasExternalReferences(filePath, exportedItem)) {
              if (['enum', 'type', 'interface'].includes(exportedItem.type)) {
                collector.addIssue({ type: 'nsTypes', filePath, symbol, symbolType: exportedItem.type });
              } else {
                collector.addIssue({ type: 'nsExports', filePath, symbol });
              }
            }
          } else {
            if (['enum', 'type', 'interface'].includes(exportedItem.type)) {
              collector.addIssue({ type: 'types', filePath, symbol, symbolType: exportedItem.type });
            } else {
              collector.addIssue({ type: 'exports', filePath, symbol });
            }
          }
        }
      }
    }
  }

  if (report.dependencies) {
    const { dependencyIssues, devDependencyIssues } = deputy.settleDependencyIssues();
    dependencyIssues.forEach(issue => collector.addIssue(issue));
    if (!isProduction) devDependencyIssues.forEach(issue => collector.addIssue(issue));
  }

  const { issues, counters } = collector.getIssues();

  console.clear();

  return { report, issues, counters };
};
