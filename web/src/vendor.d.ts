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

declare module 'd3-voronoi-map' {
  export interface VoronoiMapPolygon<T> extends Array<[number, number]> {
    site: { x: number; y: number; weight: number; originalObject: { data: { originalData: T } } };
  }

  export interface VoronoiMapSimulation<T> {
    weight(fn: (d: T) => number): VoronoiMapSimulation<T>;
    clip(polygon: Array<[number, number]>): VoronoiMapSimulation<T>;
    prng(random: () => number): VoronoiMapSimulation<T>;
    initialPosition(fn: (d: T, i: number) => [number, number]): VoronoiMapSimulation<T>;
    minWeightRatio(ratio: number): VoronoiMapSimulation<T>;
    maxIterationCount(count: number): VoronoiMapSimulation<T>;
    convergenceRatio(ratio: number): VoronoiMapSimulation<T>;
    stop(): VoronoiMapSimulation<T>;
    tick(): VoronoiMapSimulation<T>;
    state(): { ended: boolean; polygons: Array<VoronoiMapPolygon<T>> };
  }

  export function voronoiMapSimulation<T>(data: T[]): VoronoiMapSimulation<T>;
}
