import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional, Tuple, Sequence, Set
from gymnasium import Env, spaces

DEFAULT_POINTS_BY_POSITION = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]


def _split_track_types(cell: str) -> Set[str]:
    """
    Split "Sunny/Night" -> {"Sunny", "Night"}
    "-" or empty -> empty set (means 'any' in upgrades; means 'none' for cars)
    """
    if not isinstance(cell, str):
        return set()
    cell = cell.strip()
    if cell == "-" or cell == "":
        return set()
    return {p.strip() for p in cell.split("/") if p.strip()}


def _parse_type_bonus(cell: str) -> Tuple[int, int]:
    """
    Parse 'Type Bonus' like '30 Core Power' or '20 Max Laps' -> (bonus_core, bonus_max)
    """
    if not isinstance(cell, str):
        return 0, 0
    s = cell.strip()
    if not s:
        return 0, 0
    parts = s.split()
    # expect: [number, "Core"/"Max", "Power"/"Laps"]
    try:
        val = int(parts[0])
    except Exception:
        return 0, 0
    if "Core" in parts[1:]:
        return val, 0
    if "Max" in parts[1:]:
        return 0, val
    return 0, 0


class Overdr1veEnv(Env):
    """
    Data-driven environment for Overdr1ve.

    CSV schemas (as provided):

    tracks.csv:
        Track,Total Laps,Track Type,Type Bonus
        Track 01,50,Sunny,30 Core Power
        ...

    cars.csv:
        Car,Core Power,Max Laps,Track Type
        Car 01,300,50,Sunny
        Car 09,320,50,-
        Car 11,300,40,Sunny/Night
        ...

    upgrades.csv:
        Upgrade,Core Power,Max Laps,Track Type Condition
        Upgrade 01,20,0,-
        Upgrade 04,20,10,Sunny/Night
        ...

    Rules implemented:
    - Each step = run one track.
    - Effective Core = Car Core + Track TypeBonus(Core) + Upgrade(Core if its condition matches this track).
    - Effective MaxLaps = Car MaxLaps + Track TypeBonus(Max) + Upgrade(Max if condition matches).
    - DNF if effective MaxLaps < Total Laps for that track (unless you later add “ignore max laps”—not in this schema).
    - Rank by Effective Core (DNFs always at the bottom). Reward = F1-like points by finishing position; 0 if DNF.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        tracks_df: pd.DataFrame,
        cars_df: pd.DataFrame,
        upgrades_df: Optional[pd.DataFrame] = None,
        agent_car_id: int = 0,  # index in cars_df of the learning car
        points_by_position: Optional[Sequence[int]] = None,
        shuffle_tracks_each_reset: bool = False,
        seed: Optional[int] = None,
    ):
        super().__init__()
        self._rng = np.random.default_rng(seed)

        # ---- Validate & normalize inputs ----
        self._tracks_df_original = self._validate_tracks(tracks_df.copy())
        self.cars_df = self._validate_cars(cars_df.copy())
        self.upgrades_df = self._validate_upgrades(upgrades_df.copy()) if upgrades_df is not None else None

        # Dynamic track types from tracks.csv
        self.TRACK_TYPES: List[str] = sorted(self._tracks_df_original["Track Type"].unique().tolist())
        self.TT2IDX: Dict[str, int] = {t: i for i, t in enumerate(self.TRACK_TYPES)}

        # Agent & opponents
        if not (0 <= agent_car_id < len(self.cars_df)):
            raise ValueError(f"agent_car_id {agent_car_id} out of range (len={len(self.cars_df)})")
        self.agent_car_id = agent_car_id
        self.agent_car = self.cars_df.iloc[self.agent_car_id]
        self.opponents_df = self.cars_df.drop(self.agent_car_id).reset_index(drop=True)

        # Points table
        self.points_by_position = list(points_by_position or DEFAULT_POINTS_BY_POSITION)
        grid = len(self.cars_df)
        if len(self.points_by_position) < grid:
            self.points_by_position += [0] * (grid - len(self.points_by_position))

        self.shuffle_tracks_each_reset = shuffle_tracks_each_reset

        # ---- Actions come from upgrades_df; always include a "No Upgrade" action at index 0 ----
        self.actions_catalog = self._build_actions()
        self.n_actions = len(self.actions_catalog)
        self.action_space = spaces.Discrete(self.n_actions)

        # ---- Observation space ----
        # obs = [
        #   agent_core, agent_max_laps,
        #   onehot(track_type) ... dynamic size,
        #   track_total_laps,
        #   opp_mean_core, opp_mean_maxlaps
        # ]
        obs_dim = 2 + len(self.TRACK_TYPES) + 1 + 2
        self.observation_space = spaces.Box(low=-np.inf, high=np.inf, shape=(obs_dim,), dtype=np.float32)

        # ---- Runtime state ----
        self._tracks_df = self._tracks_df_original.copy()
        self.track_idx = 0
        self.total_reward = 0.0

    # ---------------- Validators ----------------
    def _validate_tracks(self, df: pd.DataFrame) -> pd.DataFrame:
        need = ["Track", "Total Laps", "Track Type", "Type Bonus"]
        for c in need:
            if c not in df.columns:
                raise ValueError(f"tracks_df must contain '{c}'")
        df["Track"] = df["Track"].astype(str)
        df["Track Type"] = df["Track Type"].astype(str)
        df["Total Laps"] = pd.to_numeric(df["Total Laps"], errors="raise").astype(int)
        df["Type Bonus"] = df["Type Bonus"].astype(str)
        return df.reset_index(drop=True)

    def _validate_cars(self, df: pd.DataFrame) -> pd.DataFrame:
        need = ["Car", "Core Power", "Max Laps", "Track Type"]
        for c in need:
            if c not in df.columns:
                raise ValueError(f"cars_df must contain '{c}'")
        df["Car"] = df["Car"].astype(str)
        df["Core Power"] = pd.to_numeric(df["Core Power"], errors="raise").astype(float)
        df["Max Laps"] = pd.to_numeric(df["Max Laps"], errors="raise").astype(int)
        df["Track Type"] = df["Track Type"].astype(str)
        # Store parsed car track types (currently not used for bonuses, but kept for future logic)
        df["_CarTrackTypesSet"] = df["Track Type"].apply(_split_track_types)
        return df.reset_index(drop=True)

    def _validate_upgrades(self, df: pd.DataFrame) -> pd.DataFrame:
        need = ["Upgrade", "Core Power", "Max Laps", "Track Type Condition"]
        for c in need:
            if c not in df.columns:
                raise ValueError(f"upgrades_df must contain '{c}'")
        df["Upgrade"] = df["Upgrade"].astype(str)
        df["Core Power"] = pd.to_numeric(df["Core Power"], errors="coerce").fillna(0).astype(float)
        df["Max Laps"] = pd.to_numeric(df["Max Laps"], errors="coerce").fillna(0).astype(int)
        df["Track Type Condition"] = df["Track Type Condition"].astype(str)
        df["_CondTypesSet"] = df["Track Type Condition"].apply(_split_track_types)  # empty set == ANY
        return df.reset_index(drop=True)

    # ---------------- Actions builder ----------------
    def _build_actions(self) -> List[Dict[str, Any]]:
        actions: List[Dict[str, Any]] = [{
            "name": "No Upgrade",
            "add_core": 0.0,
            "add_max": 0,
            "cond": set(),  # empty => allowed for any track
        }]
        if self.upgrades_df is None or len(self.upgrades_df) == 0:
            return actions

        for _, r in self.upgrades_df.iterrows():
            actions.append({
                "name": r["Upgrade"],
                "add_core": float(r["Core Power"]),
                "add_max": int(r["Max Laps"]),
                "cond": set(r["_CondTypesSet"]),  # empty => ANY
            })
        return actions

    # ---------------- Helpers ----------------
    def _track_row(self) -> pd.Series:
        if not (0 <= self.track_idx < len(self._tracks_df)):
            raise RuntimeError(f"track_idx {self.track_idx} out of bounds")
        return self._tracks_df.iloc[self.track_idx]

    def _get_obs(self) -> np.ndarray:
        tr = self._track_row()
        ttype = tr["Track Type"]
        onehot = np.zeros(len(self.TRACK_TYPES), dtype=np.float32)
        onehot[self.TRACK_TYPES.index(ttype)] = 1.0

        opp_mean_core = float(self.opponents_df["Core Power"].mean())
        opp_mean_max = float(self.opponents_df["Max Laps"].mean())

        obs = np.array([
            float(self.agent_car["Core Power"]),
            float(self.agent_car["Max Laps"]),
            *onehot.tolist(),
            float(tr["Total Laps"]),
            opp_mean_core,
            opp_mean_max,
        ], dtype=np.float32)
        return obs

    def _upgrade_applies_on_track(self, action_idx: int, track_type: str) -> bool:
        a = self.actions_catalog[int(action_idx)]
        cond: Set[str] = a["cond"]
        if len(cond) == 0:
            return True  # '-' in CSV -> empty set -> ANY
        return track_type in cond

    def _effective_stats_for_car(self, base_core: float, base_max: int, track_type: str,
                                 track_bonus_core: int, track_bonus_max: int,
                                 action_idx: int) -> Tuple[float, int, bool]:
        # track bonus applies to everyone
        core = base_core + track_bonus_core
        max_laps = base_max + track_bonus_max

        # upgrade bonus applies only if condition matches
        if self._upgrade_applies_on_track(action_idx, track_type):
            a = self.actions_catalog[action_idx]
            core += a["add_core"]
            max_laps += a["add_max"]

        # This schema has no "ignore max laps"; DNF purely on max laps vs required laps
        return core, int(max_laps), True

    def _rank_and_points(self, grid_core: np.ndarray, grid_dnf: np.ndarray, agent_index: int) -> Tuple[int, int]:
        idxs = np.arange(len(grid_core))
        # DNFs are last; within groups: by core desc (add tiny noise for tie-break)
        noise = self._rng.normal(0, 1e-6, size=len(grid_core))
        order = sorted(idxs, key=lambda i: (grid_dnf[i], -(grid_core[i] + noise[i])))
        position = order.index(agent_index) + 1  # 1-based
        points = self.points_by_position[position - 1] if not grid_dnf[agent_index] else 0
        return position, points

    # ---------------- Gym API ----------------
    def reset(self, *, seed: Optional[int] = None, options: Optional[Dict[str, Any]] = None):
        super().reset(seed=seed)
        if seed is not None:
            self._rng = np.random.default_rng(seed)

        self._tracks_df = (
            self._tracks_df_original.sample(
                frac=1.0, random_state=int(self._rng.integers(0, 1_000_000))
            ).reset_index(drop=True)
            if self.shuffle_tracks_each_reset else
            self._tracks_df_original.copy()
        )
        self.track_idx = 0
        self.total_reward = 0.0
        obs = self._get_obs()
        return obs, {}

    def step(self, action: int):
        if not (0 <= int(action) < self.n_actions):
            raise ValueError(f"Invalid action {action}; expected 0..{self.n_actions-1}")
        tr = self._track_row()
        track_type: str = tr["Track Type"]
        req_laps: int = int(tr["Total Laps"])
        bonus_core, bonus_max = _parse_type_bonus(tr["Type Bonus"])

        # ---- Agent effective stats ----
        agent_base_core = float(self.agent_car["Core Power"])
        agent_base_max = int(self.agent_car["Max Laps"])
        agent_core, agent_max, _ = self._effective_stats_for_car(
            agent_base_core, agent_base_max, track_type, bonus_core, bonus_max, int(action)
        )
        agent_dnf = agent_max < req_laps

        # ---- Opponents effective stats ----
        opp_core = self.opponents_df["Core Power"].to_numpy(dtype=float)
        opp_max = self.opponents_df["Max Laps"].to_numpy(dtype=int)

        # Everyone receives the track bonus; opponents don't use the chosen upgrade
        opp_core_eff = opp_core + bonus_core
        opp_max_eff = opp_max + bonus_max
        opp_dnf = opp_max_eff < req_laps

        # ---- Compose grid ----
        grid_core = np.concatenate([opp_core_eff, np.array([agent_core])], axis=0)
        grid_dnf = np.concatenate([opp_dnf, np.array([agent_dnf])], axis=0)
        agent_grid_idx = len(grid_core) - 1

        # ---- Rank & reward ----
        pos, pts = self._rank_and_points(grid_core, grid_dnf, agent_grid_idx)
        reward = float(pts)
        self.total_reward += reward

        # ---- Advance ----
        self.track_idx += 1
        terminated = self.track_idx >= len(self._tracks_df)
        truncated = False

        obs = np.zeros(self.observation_space.shape, dtype=np.float32) if terminated else self._get_obs()
        info = {
            "track": tr["Track"],
            "track_type": track_type,
            "required_laps": req_laps,
            "type_bonus_core": bonus_core,
            "type_bonus_max": bonus_max,
            "action": self.actions_catalog[int(action)]["name"],
            "agent_effective_core": agent_core,
            "agent_effective_max": agent_max,
            "agent_dnf": bool(agent_dnf),
            "position": pos,
            "points": pts,
            "episode_return": self.total_reward if terminated else None,
        }
        return obs, reward, terminated, truncated, info

    def render(self):
        print(f"[render] track {self.track_idx}/{len(self._tracks_df)} total_return={self.total_reward:.1f}")
