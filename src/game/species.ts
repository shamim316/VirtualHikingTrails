/**
 * The living things you can find, and what the journal says about them.
 *
 * Each entry ties a processed model to where it will grow, how it should be
 * scattered, and what you learn when you first notice one. The natural history
 * is real: these are the plants the scans were made from, or their closest
 * common relatives, and the notes are the kind of thing a field guide would
 * tell you rather than flavour text.
 *
 * `habitat` weights are the scatterer's whole brain. A species with
 * `moisture: 0.9` clusters in damp hollows and along streambanks; one with
 * `canopy: -0.8` refuses to grow in deep shade. Nothing is placed by hand.
 */

import { Biome } from '../world/heightfield';

export type SpeciesGroup = 'canopy' | 'understory' | 'flower' | 'ground' | 'rock' | 'deadwood';

export interface Habitat {
  /** Biomes this may appear in at all. */
  biomes: Biome[];
  /** Preferred altitude band in metres; density falls off outside it. */
  altitude: [number, number];
  /** Steepest ground it will hold on, 0..1. */
  maxSlope: number;
  /** Affinity for damp ground, -1 (avoids) .. 1 (needs). */
  moisture: number;
  /** Affinity for tree cover, -1 (open ground only) .. 1 (deep shade). */
  canopy: number;
  /** Instances per hectare at full suitability. */
  density: number;
  /** How tightly it clumps: 0 scatters evenly, 1 grows in tight stands. */
  clumping: number;
}

export interface Species {
  /** Matches the processed model id in public/assets/models. */
  id: string;
  name: string;
  latin: string;
  group: SpeciesGroup;
  /** Metres, for the scatterer's random scaling and the LOD thresholds. */
  height: [number, number];
  /** XP for a first sighting. Rarity, roughly. */
  xp: number;
  /** One line of natural history for the journal. */
  note: string;
  habitat: Habitat;
}

const FOREST_BIOMES = [Biome.Forest, Biome.Conifer];
const OPEN_BIOMES = [Biome.Meadow, Biome.Lakeshore];
const ALL_GROWABLE = [Biome.Meadow, Biome.Forest, Biome.Conifer, Biome.Riverbank, Biome.Lakeshore];

export const SPECIES: Species[] = [
  // --- canopy --------------------------------------------------------------
  {
    id: 'fir_tree',
    name: 'Silver Fir',
    latin: 'Abies alba',
    group: 'canopy',
    height: [14, 30],
    xp: 20,
    note: 'Holds its needles flat in two ranks, each with two white bands beneath — the "silver" is on the underside, visible only when the wind turns a branch over.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [300, 640], maxSlope: 0.5,
      moisture: 0.25, canopy: 0.85, density: 78, clumping: 0.65,
    },
  },
  {
    id: 'pine_tree',
    name: 'Scots Pine',
    latin: 'Pinus sylvestris',
    group: 'canopy',
    height: [12, 26],
    xp: 20,
    note: 'The bark goes copper-pink high on the trunk where the plates thin. Old trees flatten their crowns and lean toward whichever way the light comes from.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [240, 600], maxSlope: 0.55,
      moisture: -0.2, canopy: 0.8, density: 66, clumping: 0.6,
    },
  },
  {
    id: 'broadleaf_tree',
    name: 'Downy Birch',
    latin: 'Betula pubescens',
    group: 'canopy',
    height: [8, 17],
    xp: 18,
    note: 'First tree back onto cleared or burnt ground. Its leaf litter breaks down fast and sweetens the soil, which is why other species follow it in.',
    habitat: {
      biomes: [Biome.Forest, Biome.Riverbank, Biome.Meadow], altitude: [200, 500], maxSlope: 0.45,
      moisture: 0.55, canopy: 0.5, density: 52, clumping: 0.5,
    },
  },
  {
    id: 'island_tree',
    name: 'Grey Alder',
    latin: 'Alnus incana',
    group: 'canopy',
    height: [7, 15],
    xp: 18,
    note: 'Fixes nitrogen at its roots, so it thrives on raw gravel where nothing else will start. Almost always within a few metres of running water.',
    habitat: {
      biomes: [Biome.Riverbank, Biome.Lakeshore, Biome.Forest], altitude: [190, 460], maxSlope: 0.4,
      moisture: 0.9, canopy: 0.35, density: 58, clumping: 0.7,
    },
  },
  {
    id: 'fir_young',
    name: 'Young Fir',
    latin: 'Abies alba',
    group: 'canopy',
    height: [2.5, 6],
    xp: 8,
    note: 'Firs are patient. A sapling can wait decades in deep shade, barely growing, until a neighbour falls and the light arrives.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [300, 660], maxSlope: 0.55,
      moisture: 0.3, canopy: 0.9, density: 95, clumping: 0.55,
    },
  },
  {
    id: 'pine_young',
    name: 'Young Pine',
    latin: 'Pinus sylvestris',
    group: 'canopy',
    height: [2, 5],
    xp: 8,
    note: 'Unlike the firs, pine seedlings need open sky. They colonise gaps and edges, which is why you find them along the margins rather than under the canopy.',
    habitat: {
      biomes: [Biome.Conifer, Biome.Meadow], altitude: [250, 620], maxSlope: 0.55,
      moisture: -0.3, canopy: -0.3, density: 80, clumping: 0.5,
    },
  },
  {
    id: 'fir_seedling',
    name: 'Fir Seedling',
    latin: 'Abies alba',
    group: 'understory',
    height: [0.4, 1.1],
    xp: 5,
    note: 'Most of these will not make it. A hectare of forest floor can hold thousands; a handful reach the canopy.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [300, 660], maxSlope: 0.6,
      moisture: 0.35, canopy: 0.95, density: 900, clumping: 0.7,
    },
  },

  // --- deadwood ------------------------------------------------------------
  {
    id: 'dead_trunk',
    name: 'Fallen Trunk',
    latin: '',
    group: 'deadwood',
    height: [1.2, 2.6],
    xp: 10,
    note: 'A dead tree hosts more life than a living one — beetles, fungi, and the woodpeckers that come for the beetles. Foresters call it habitat; it used to be called untidy.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [200, 640], maxSlope: 0.4,
      moisture: 0.4, canopy: 0.8, density: 90, clumping: 0.3,
    },
  },
  {
    id: 'stump',
    name: 'Weathered Stump',
    latin: '',
    group: 'deadwood',
    height: [0.5, 1.3],
    xp: 6,
    note: 'The rings are still readable for years after a tree goes. Narrow bands are hard seasons — drought, late frost, a neighbour stealing the light.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [200, 620], maxSlope: 0.4,
      moisture: 0.35, canopy: 0.7, density: 110, clumping: 0.25,
    },
  },
  {
    id: 'stump_mossy',
    name: 'Mossy Stump',
    latin: '',
    group: 'deadwood',
    height: [0.5, 1.2],
    xp: 8,
    note: 'Once moss takes a stump it holds water like a sponge, and seedlings root in the top. Foresters call these nurse logs.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [220, 560], maxSlope: 0.4,
      moisture: 0.75, canopy: 0.9, density: 90, clumping: 0.35,
    },
  },
  {
    id: 'roots',
    name: 'Root Plate',
    latin: '',
    group: 'deadwood',
    height: [0.6, 1.6],
    xp: 9,
    note: 'When a tree goes over in a gale it brings its roots and a disc of soil up with it, leaving a pit and a mound that stay in the ground for centuries.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [200, 600], maxSlope: 0.45,
      moisture: 0.5, canopy: 0.75, density: 60, clumping: 0.2,
    },
  },
  {
    id: 'pine_roots',
    name: 'Exposed Roots',
    latin: '',
    group: 'deadwood',
    height: [0.3, 0.8],
    xp: 7,
    note: 'Roots break the surface where rain has stripped the soil from around them — usually on a slope, usually beside a path something walks regularly.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [220, 600], maxSlope: 0.6,
      moisture: 0.2, canopy: 0.7, density: 130, clumping: 0.4,
    },
  },

  // --- understory ----------------------------------------------------------
  {
    id: 'fern',
    name: 'Lady Fern',
    latin: 'Athyrium filix-femina',
    group: 'understory',
    height: [0.4, 0.95],
    xp: 6,
    note: 'Unfurls in spring as a tight spiral — a fiddlehead — and dies back at the first hard frost. Ferns were here a hundred million years before the first flower.',
    habitat: {
      biomes: [Biome.Forest, Biome.Conifer, Biome.Riverbank], altitude: [190, 560], maxSlope: 0.5,
      moisture: 0.85, canopy: 0.8, density: 1400, clumping: 0.75,
    },
  },
  {
    id: 'shrub_a',
    name: 'Bilberry',
    latin: 'Vaccinium myrtillus',
    group: 'understory',
    height: [0.25, 0.6],
    xp: 7,
    note: 'Carpets acid soil under conifers. The berries stain your fingers purple and ripen from the bottom of the bush upward.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [280, 640], maxSlope: 0.5,
      moisture: 0.45, canopy: 0.75, density: 1600, clumping: 0.8,
    },
  },
  {
    id: 'shrub_b',
    name: 'Juniper',
    latin: 'Juniperus communis',
    group: 'understory',
    height: [0.4, 1.4],
    xp: 9,
    note: 'Takes three years to ripen a berry, so a single bush carries green and blue-black fruit at once. Grows low and wind-shorn on exposed ground.',
    habitat: {
      biomes: [Biome.Meadow, Biome.Scree, Biome.Conifer], altitude: [350, 700], maxSlope: 0.55,
      moisture: -0.4, canopy: -0.3, density: 700, clumping: 0.5,
    },
  },
  {
    id: 'shrub_c',
    name: 'Heather',
    latin: 'Calluna vulgaris',
    group: 'understory',
    height: [0.2, 0.55],
    xp: 6,
    note: 'Turns whole hillsides purple for a few weeks in late summer. Each plant may carry a million flowers, and hardly any of them are wasted — heather honey is nearly solid.',
    habitat: {
      biomes: [Biome.Meadow, Biome.Conifer], altitude: [300, 660], maxSlope: 0.5,
      moisture: -0.1, canopy: -0.5, density: 1800, clumping: 0.85,
    },
  },
  {
    id: 'shrub_d',
    name: 'Bramble',
    latin: 'Rubus fruticosus',
    group: 'understory',
    height: [0.3, 0.9],
    xp: 5,
    note: 'Arches over and roots wherever the tip touches ground, walking itself across a clearing a metre a year.',
    habitat: {
      biomes: [Biome.Forest, Biome.Meadow, Biome.Riverbank], altitude: [190, 460], maxSlope: 0.45,
      moisture: 0.5, canopy: 0.3, density: 900, clumping: 0.7,
    },
  },
  {
    id: 'nettle',
    name: 'Stinging Nettle',
    latin: 'Urtica dioica',
    group: 'understory',
    height: [0.4, 1.1],
    xp: 4,
    note: 'A reliable sign that people or animals have been here — it needs the phosphate left by long-term disturbance, and it marks old settlements for centuries.',
    habitat: {
      biomes: [Biome.Riverbank, Biome.Forest, Biome.Meadow], altitude: [190, 420], maxSlope: 0.35,
      moisture: 0.8, canopy: 0.4, density: 1100, clumping: 0.8,
    },
  },
  {
    id: 'periwinkle',
    name: 'Periwinkle',
    latin: 'Vinca minor',
    group: 'understory',
    height: [0.1, 0.25],
    xp: 6,
    note: 'Spreads by runners into a dense evergreen mat that almost nothing else grows through.',
    habitat: {
      biomes: [Biome.Forest], altitude: [190, 420], maxSlope: 0.4,
      moisture: 0.6, canopy: 0.85, density: 1300, clumping: 0.85,
    },
  },
  {
    id: 'sorrel',
    name: 'Wood Sorrel',
    latin: 'Oxalis acetosella',
    group: 'understory',
    height: [0.06, 0.15],
    xp: 7,
    note: 'Folds its three heart-shaped leaves down at dusk and in heavy rain, and opens them again by morning. Tastes sharply of apple peel.',
    habitat: {
      biomes: FOREST_BIOMES, altitude: [200, 520], maxSlope: 0.45,
      moisture: 0.8, canopy: 0.95, density: 1700, clumping: 0.8,
    },
  },

  // --- ground cover --------------------------------------------------------
  {
    id: 'moss',
    name: 'Cushion Moss',
    latin: 'Leucobryum glaucum',
    group: 'ground',
    height: [0.05, 0.14],
    xp: 5,
    note: 'Has no roots and no way to move water internally — it simply soaks up whatever lands on it and dries out completely between rains without dying.',
    habitat: {
      biomes: [Biome.Forest, Biome.Conifer, Biome.Riverbank], altitude: [190, 580], maxSlope: 0.55,
      moisture: 0.9, canopy: 0.9, density: 2200, clumping: 0.85,
    },
  },
  {
    id: 'grass_tuft',
    name: 'Tufted Hair-grass',
    latin: 'Deschampsia cespitosa',
    group: 'ground',
    height: [0.3, 0.8],
    xp: 3,
    note: 'Grows in hard tussocks that survive being grazed, trampled and waterlogged. In low sun the flower heads turn the whole meadow bronze.',
    habitat: {
      biomes: ALL_GROWABLE, altitude: [190, 620], maxSlope: 0.5,
      moisture: 0.5, canopy: -0.2, density: 2600, clumping: 0.6,
    },
  },
  {
    id: 'grass_tuft_b',
    name: 'Meadow Grass',
    latin: 'Poa pratensis',
    group: 'ground',
    height: [0.2, 0.5],
    xp: 3,
    note: 'The ordinary grass of upland pasture, and the reason a meadow sounds different from a wood when the wind crosses it.',
    habitat: {
      biomes: OPEN_BIOMES, altitude: [190, 600], maxSlope: 0.45,
      moisture: 0.3, canopy: -0.6, density: 3000, clumping: 0.4,
    },
  },
  {
    id: 'grass_fine',
    name: 'Fine Bent',
    latin: 'Agrostis capillaris',
    group: 'ground',
    height: [0.12, 0.35],
    xp: 3,
    note: 'Fine enough that a whole hillside of it moves like water when a gust crosses.',
    habitat: {
      biomes: OPEN_BIOMES, altitude: [220, 640], maxSlope: 0.5,
      moisture: 0.1, canopy: -0.7, density: 3200, clumping: 0.35,
    },
  },

  // --- flowers -------------------------------------------------------------
  {
    id: 'gazania',
    name: 'Mountain Everlasting',
    latin: 'Antennaria dioica',
    group: 'flower',
    height: [0.08, 0.22],
    xp: 12,
    note: 'Male and female flowers grow on separate plants, so a patch is often all one sex and sets no seed at all — it spreads by runners instead.',
    habitat: {
      biomes: [Biome.Meadow, Biome.Scree], altitude: [420, 700], maxSlope: 0.45,
      moisture: -0.3, canopy: -0.8, density: 420, clumping: 0.8,
    },
  },
  {
    id: 'ursinia',
    name: 'Arnica',
    latin: 'Arnica montana',
    group: 'flower',
    height: [0.15, 0.45],
    xp: 15,
    note: 'A protected plant across much of its range. It needs poor, unfertilised meadow, so it vanishes as soon as a hillside is improved.',
    habitat: {
      biomes: [Biome.Meadow], altitude: [400, 680], maxSlope: 0.4,
      moisture: 0.2, canopy: -0.7, density: 300, clumping: 0.75,
    },
  },
  {
    id: 'heliophila',
    name: 'Alpine Forget-me-not',
    latin: 'Myosotis alpestris',
    group: 'flower',
    height: [0.08, 0.25],
    xp: 14,
    note: 'The yellow eye at the centre changes to white once a flower has been pollinated, which tells the next bee not to bother.',
    habitat: {
      biomes: [Biome.Meadow, Biome.Scree], altitude: [450, 720], maxSlope: 0.45,
      moisture: 0.35, canopy: -0.7, density: 340, clumping: 0.8,
    },
  },
  {
    id: 'empodium',
    name: 'Spring Crocus',
    latin: 'Crocus vernus',
    group: 'flower',
    height: [0.06, 0.16],
    xp: 16,
    note: 'Comes up through the last of the snow, sometimes melting its own way out — the flower generates a little heat as it opens.',
    habitat: {
      biomes: [Biome.Meadow], altitude: [400, 700], maxSlope: 0.4,
      moisture: 0.5, canopy: -0.5, density: 280, clumping: 0.9,
    },
  },
  {
    id: 'stinkkruid',
    name: 'Marsh Marigold',
    latin: 'Caltha palustris',
    group: 'flower',
    height: [0.15, 0.4],
    xp: 13,
    note: 'One of the oldest flowering plants still around, and among the first to open in spring. Always with its feet in water.',
    habitat: {
      biomes: [Biome.Riverbank, Biome.Lakeshore], altitude: [190, 480], maxSlope: 0.3,
      moisture: 1.0, canopy: -0.2, density: 500, clumping: 0.85,
    },
  },
  {
    id: 'dandelion',
    name: 'Dandelion',
    latin: 'Taraxacum officinale',
    group: 'flower',
    height: [0.1, 0.35],
    xp: 4,
    note: 'Sets seed without needing to be pollinated at all, so every plant in a meadow can be a clone of the last. The clock is a dispersal device with a 100km range.',
    habitat: {
      biomes: OPEN_BIOMES, altitude: [190, 560], maxSlope: 0.4,
      moisture: 0.35, canopy: -0.5, density: 700, clumping: 0.5,
    },
  },
  {
    id: 'celandine',
    name: 'Lesser Celandine',
    latin: 'Ficaria verna',
    group: 'flower',
    height: [0.06, 0.2],
    xp: 9,
    note: 'Closes its petals before rain and opens them again in sun, reliably enough that it used to be called the spring messenger.',
    habitat: {
      biomes: [Biome.Forest, Biome.Riverbank], altitude: [190, 420], maxSlope: 0.4,
      moisture: 0.8, canopy: 0.5, density: 800, clumping: 0.85,
    },
  },

  // --- rock ----------------------------------------------------------------
  {
    id: 'boulder',
    name: 'Erratic Boulder',
    latin: '',
    group: 'rock',
    height: [0.8, 2.4],
    xp: 8,
    note: 'Carried here by ice and dropped where the ice stopped. Often a completely different rock from the ground it sits on.',
    habitat: {
      biomes: ALL_GROWABLE, altitude: [190, 800], maxSlope: 0.55,
      moisture: 0, canopy: 0, density: 120, clumping: 0.5,
    },
  },
  {
    id: 'rock_a',
    name: 'Weathered Rock',
    latin: '',
    group: 'rock',
    height: [0.3, 0.9],
    xp: 3,
    note: 'Frost does the work: water gets into a crack, freezes, expands, and over enough winters the rock comes apart along its own grain.',
    habitat: {
      biomes: ALL_GROWABLE, altitude: [190, 850], maxSlope: 0.6,
      moisture: 0, canopy: 0, density: 500, clumping: 0.45,
    },
  },
  {
    id: 'rock_b',
    name: 'Split Rock',
    latin: '',
    group: 'rock',
    height: [0.3, 1.0],
    xp: 3,
    note: '',
    habitat: {
      biomes: ALL_GROWABLE, altitude: [190, 850], maxSlope: 0.6,
      moisture: 0, canopy: 0, density: 450, clumping: 0.45,
    },
  },
  {
    id: 'rock_mossy',
    name: 'Mossy Rocks',
    latin: '',
    group: 'rock',
    height: [0.3, 1.1],
    xp: 7,
    note: 'Moss takes the north face first, where the sun never quite dries it out. It is a rough compass if you have nothing better.',
    habitat: {
      biomes: [Biome.Forest, Biome.Conifer, Biome.Riverbank], altitude: [190, 560], maxSlope: 0.55,
      moisture: 0.85, canopy: 0.7, density: 380, clumping: 0.6,
    },
  },
  {
    id: 'boulder_pale',
    name: 'Pale Boulder',
    latin: '',
    group: 'rock',
    height: [0.6, 1.8],
    xp: 5,
    note: '',
    habitat: {
      biomes: [Biome.Meadow, Biome.Scree], altitude: [300, 850], maxSlope: 0.6,
      moisture: -0.5, canopy: -0.4, density: 260, clumping: 0.55,
    },
  },
  {
    id: 'boulder_dark',
    name: 'Dark Boulder',
    latin: '',
    group: 'rock',
    height: [0.6, 1.8],
    xp: 5,
    note: '',
    habitat: {
      biomes: [Biome.Scree, Biome.Meadow], altitude: [380, 880], maxSlope: 0.6,
      moisture: -0.5, canopy: -0.5, density: 300, clumping: 0.55,
    },
  },
  {
    id: 'stone',
    name: 'Loose Stone',
    latin: '',
    group: 'rock',
    height: [0.1, 0.35],
    xp: 2,
    note: '',
    habitat: {
      biomes: ALL_GROWABLE, altitude: [190, 900], maxSlope: 0.65,
      moisture: 0, canopy: 0, density: 1400, clumping: 0.4,
    },
  },
  {
    id: 'cliff',
    name: 'Rock Outcrop',
    latin: '',
    group: 'rock',
    height: [2.5, 7],
    xp: 12,
    note: 'Where the bedrock breaks through the soil you can read the whole hillside’s history in a few metres of exposed strata.',
    habitat: {
      biomes: [Biome.Scree, Biome.Meadow], altitude: [350, 880], maxSlope: 0.7,
      moisture: -0.3, canopy: -0.4, density: 45, clumping: 0.6,
    },
  },
];

export const SPECIES_BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

/** Total XP available from finding one of everything. */
export const TOTAL_SPECIES_XP = SPECIES.reduce((sum, s) => sum + s.xp, 0);

/** Species that should be considered for a given biome. */
export function speciesForBiome(biome: Biome): Species[] {
  return SPECIES.filter((s) => s.habitat.biomes.includes(biome));
}
