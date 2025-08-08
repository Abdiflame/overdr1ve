import os
import argparse
import pandas as pd
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.evaluation import evaluate_policy

from overdr1ve_env import Overdr1veEnv

def make_env(tracks_csv, cars_csv, upgrades_csv, agent_car_id, shuffle_tracks):
    def _thunk():
        tracks_df = pd.read_csv(tracks_csv)
        cars_df = pd.read_csv(cars_csv)
        upgrades_df = pd.read_csv(upgrades_csv) if upgrades_csv and os.path.exists(upgrades_csv) else None
        env = Overdr1veEnv(
            tracks_df=tracks_df,
            cars_df=cars_df,
            upgrades_df=upgrades_df,
            agent_car_id=agent_car_id,
            shuffle_tracks_each_reset=shuffle_tracks,
        )
        return Monitor(env)
    return _thunk

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks_csv", type=str, default="data_csv/tracks.csv")
    ap.add_argument("--cars_csv", type=str, default="data_csv/cars.csv")
    ap.add_argument("--upgrades_csv", type=str, default="data_csv/upgrades.csv")
    ap.add_argument("--agent_car_id", type=int, default=0)
    ap.add_argument("--total_timesteps", type=int, default=1_000_000)
    ap.add_argument("--logdir", type=str, default="./tensorboard_logs/PPO_overdr1ve")
    ap.add_argument("--save_dir", type=str, default="./checkpoints")
    ap.add_argument("--eval_episodes", type=int, default=50)
    ap.add_argument("--shuffle_tracks", action="store_true")
    ap.add_argument("--device", type=str, default="cpu")  # PPO MLP -> CPU is fine
    args = ap.parse_args()

    os.makedirs(args.logdir, exist_ok=True)
    os.makedirs(args.save_dir, exist_ok=True)

    venv = DummyVecEnv([make_env(args.tracks_csv, args.cars_csv, args.upgrades_csv, args.agent_car_id, args.shuffle_tracks)])
    venv = VecNormalize(venv, norm_obs=True, norm_reward=True, clip_obs=10.0, gamma=0.99, training=True)

    model = PPO(
        policy="MlpPolicy",
        env=venv,
        device=args.device,
        tensorboard_log=args.logdir,
        verbose=1,
        n_steps=1024,
        batch_size=256,
        learning_rate=3e-4,
        ent_coef=0.01,
        gae_lambda=0.95,
        n_epochs=10,
        gamma=0.99,
        clip_range=0.2,
    )

    print(f"Using {args.device} device")
    model.learn(total_timesteps=args.total_timesteps, progress_bar=True)

    model_path = os.path.join(args.save_dir, "ppo_overdr1ve")
    model.save(model_path)
    venv.save(os.path.join(args.save_dir, "vecnorm_stats.pkl"))
    print(f"Saved model to {model_path} and vecnorm_stats.pkl")

    # ---- Eval ----
    eval_env = DummyVecEnv([make_env(args.tracks_csv, args.cars_csv, args.upgrades_csv, args.agent_car_id, args.shuffle_tracks)])
    eval_env = VecNormalize.load(os.path.join(args.save_dir, "vecnorm_stats.pkl"), eval_env)
    eval_env.training = False
    eval_env.norm_reward = False

    loaded = PPO.load(model_path, env=eval_env, device=args.device)
    mean_r, std_r = evaluate_policy(loaded, eval_env, n_eval_episodes=args.eval_episodes, deterministic=True)
    print(f"[EVAL] mean_reward={mean_r:.3f} ± {std_r:.3f} over {args.eval_episodes} episodes")

if __name__ == "__main__":
    main()
