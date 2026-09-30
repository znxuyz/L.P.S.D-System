declare module 'd3-voronoi-treemap' {
  import type { HierarchyNode } from 'd3';

  export interface VoronoiTreemap {
    <T>(root: HierarchyNode<T>): void;
    clip(polygon: Array<[number, number]>): VoronoiTreemap;
    prng(random: () => number): VoronoiTreemap;
    minWeightRatio(ratio: number): VoronoiTreemap;
    maxIterationCount(count: number): VoronoiTreemap;
    convergenceRatio(ratio: number): VoronoiTreemap;
  }

  export function voronoiTreemap(): VoronoiTreemap;
}
