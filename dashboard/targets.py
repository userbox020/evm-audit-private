"""Isolated curated panels plus the paginated trade-candidate entrypoint."""

from __future__ import annotations

import math
import re
from dataclasses import replace
from decimal import Decimal
from typing import Any

from . import ops
from .artifacts import ALLOWLIST
from .normalize import AGING, FRESH, STALE, UNKNOWN, timestamp


def arb_morpho_watch_valid(data: Any) -> bool:
    return (isinstance(data, dict) and type(data.get("chainId")) is int
            and data["chainId"] == 42161 and isinstance(data.get("targets"), list))


SENTINEL = "top_whale_triggers_status"
V3_WATCH = "top_whale_executor_live_watch"
V3_2K_2L_WATCH = "top_whale_executor_live_watch_2k_2l"
V4_WATCH = "aave_v4_executor_live_watch"
RANK1_V2_WATCH = "rank1_aave_v4_v2_watch"
RANK1_TARGET = "target1_AaveV4_USDe_USDC"
RANK1_ID = "target-1-aave-v4-usde-usdc"
RANK1_BINDING = {
    "borrower": "0x1cb432f80416f07db4420b8c20447924a0658894",
    "spoke": "0xba1b3d55d249692b669a164024a838309b7508af",
    "deployedExecutor": "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7",
    "owner": "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a",
}
ARB_WATCH = "arb_morpho_executor_live_watch"
BASE_WATCH = "base_morpho_executor_live_watch"
READS = {
    SENTINEL: ops.top_whale_triggers_valid,
    "aave_v4_v3_morpho_liquidator_deploy": ops.v4_v3_morpho_deploy_valid,
    "aave_v4_flash_liquidator_deploy": ops.aave_v4_flash_deploy_valid,
    V4_WATCH: ops.aave_v4_live_watch_valid,
    V3_WATCH: ops.top_whale_executor_watch_valid,
    ARB_WATCH: arb_morpho_watch_valid,
    BASE_WATCH: ops.base_morpho_live_watch_valid,
    "aave_v4_multi_spoke_rehearsal": ops.aave_v4_rehearsal_valid,
    "base_morpho_usde_rehearsal": ops.base_morpho_rehearsal_valid,
}
MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
ARB_MORPHO = "0x6c247b1f6182318877311737bac0844baa518f5e"
ARB_EXECUTOR = "0x2175290a1132fb5e49f6e96cb1610e2cdd7b81c4"
ARB_UNIVERSAL_EXECUTOR = "0xf882dd88c153546162cb687d2414b3e7732d0c9e"
ARB_FLUID_EXECUTOR = ARB_UNIVERSAL_EXECUTOR
ARB_FLUID_ID = "arb-5-fluid60-susde-usdt0"
ARB_FLUID_54_ID = "arb-6-fluid54-usdai-usdt0"
ARB_FLUID_42_ID = "arb-fluid-v42-usdai-usdc-usdt0"
ARB_FLUID_42_BORROWER = "0xb53009e4dc25a494f3bee03ab121517e74b59f75"
ARB_SINGLES = {
    "#ARB8": "arb-8-syrupusdg-usdg-0x5163",
    "#ARB9": "arb-9-syrupusdg-usdg-0x6efc",
}
_ARB_METADATA = {
    ARB_FLUID_ID: (
        "#ARB5", "sUSDe-USDT / USDT0 (Arbitrum)",
        "0x81a0dd6c5ddb8474b483c31309b66d7173263cbb",
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT0",
        "0x15a2fe730e24ad431e41bc3ba2eb80088149ab04", "sUSDe-USDT LP",
        64000.00, 752.25,
        "ARMED on Arbitrum Universal 0xf882...0c9e ($63.5k USDT0 debt in Fluid T2 Vault 60 -> +$752.25 USDT0 simulated).",
    ),
    ARB_FLUID_54_ID: (
        "#ARB6", "USDai-USDT0 / USDT0 (Arbitrum)",
        "0xd9a7dcdc57c6e44f00740dc73664fa456b983669",
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT0",
        "0x0a1a3b8f29f33699b6a64c23a46ed313b3bc4927", "USDai-USDT0 LP",
        5461.44, 315.66,
        "ARMED on Arbitrum Universal 0xf882...0c9e ($15.5k USDT0 debt in Fluid T2 Vault 54; NFT #8998 at 124.92 bps -> +$315.66 USDT0 simulated).",
    ),
    ARB_FLUID_42_ID: (
        "#ARB7", "USDai-USDC / USDT0 (Arbitrum)",
        "0x5eb4ba0c320b59f825cc8d2291f672247aa5d06f",
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT0",
        None, "USDai-USDC LP", None, None,
        "Arbitrum Universal 0xf882...0c9e monitors Fluid T2 Vault 42; current profitability and execution readiness are not established.",
    ),
}
# Fixed public bindings from execute-arb-morpho-liquidation.js; not approval semantics.
ARB_BINDINGS = {
    "#ARB1": ("0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65", "0xde895fd4a9d1ca693485fcfc2ee47d8c3b47f810bbce3c965c60d97b855d4ed2", "sUSDS / USDT0 (Arb)"),
    "#ARB2": ("0x8d54e7f07f5502dc6428644c72850790c5dbc198", "0xde895fd4a9d1ca693485fcfc2ee47d8c3b47f810bbce3c965c60d97b855d4ed2", "sUSDS / USDT0 (Arb)"),
    "#ARB3": ("0xb0b61c87662b56b5bb614867b430ad36c680d6db", "0x71c2954e00c8f72864600c9d1d1cd70fa15202c4294cd938d80add3be2eced26", "sUSDai / USDC (Arb)"),
    "#ARB4": ("0x9b6f53be2af3cd989f82134deb1963532d3ec50e", "0x77fe2f7c2dd6f4da6bc5f445b06052ff8df55cb70cfce9afc16ec3c69a5fd3a3", "sUSDS / USDC (Arb)"),
}
ARB_USDG_BINDINGS = {
    "#ARB8": ("0x5163d2109ac93b447828789b8df537bc9fa3bf19", "0xfc2a80cb390c45e7e79ad24792123fbf5a96d4653db44e29646fa7af159dda7c", "syrupUSDG / USDG (Arbitrum)"),
    "#ARB9": ("0x6efc48b8b6222924fa6ea95d174af5518b761177", "0xfc2a80cb390c45e7e79ad24792123fbf5a96d4653db44e29646fa7af159dda7c", "syrupUSDG / USDG (Arbitrum)"),
}
ARB_ALL_BINDINGS = {**ARB_BINDINGS, **ARB_USDG_BINDINGS}
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
SPARK_POOL = "0xc13e21b648a5ee794902342038ff3adab66be987"
UNIFIED_EXECUTOR = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"
M1_USER = "0xa3609cf7872faa7804281c7c5edb8b2d33001089"
M1_EXECUTOR = "0xaf5b033e23ac555c09096bf39979a855e09907ba"
M2_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627"
# Public deployment identity, not activation or execution authority.
M32_EXECUTOR = "0x2c94b422884c0495cae3cef9ce7ab337fac247c4"
M32_CONTRACT_NAME = "MorphoM32CurveUnwindLiquidator"
M32_RUNTIME_KECCAK256 = "0x2b3e40560e4e0ce96999b35d6f0141def9d7cba00baf7aa3caa7f22cd3f4a191"
M32_READINESS_NOTE = "Configured dedicated MorphoM32CurveUnwindLiquidator; historical local-fork estimates do not establish runner liveness or execution readiness."
M32_REFERENCE = "m32_historical_local_rehearsal"
M32_VALUATION = "ORIGINAL_HISTORICAL_FEEDS_LOCAL_SCENARIO_ONLY"
UNIVERSAL_EXECUTOR = "0xc50321a07dab061d59b992e57a2ef4dca0d33089"
M7_EXECUTOR = "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4"
YN_EXECUTOR = "0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35"
EULER_EVK_EXECUTOR = "0xac262ce4319b887aeac069730c7978c98a8c5fe6"
BASE_EULER_EVK_EXECUTOR = "0x0aaa75499fbcb7db821c3aefc84433a53cdeb9b9"
ETH_UNIVERSAL_EULER_EXECUTOR = "0xa8964ab01c35f8e7de8457223861624b66007a6a"
UNIV4_FLASH_EXECUTOR = "0x61251a22540e7148cc8ba58cfb0916a898865e1f"
AAVE_V4_SPOKE_FLASH_EXECUTOR = "0x6125ba227a66a1efbb780d445ea6b79f8b285e1f"
PENDLE_PT_EXECUTOR = "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d"
BASE_EXECUTOR = "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32"
BASE_UNIVERSAL_EXECUTOR = "0x86d446bafcd87737d0b763f1e8af65e5c424ba53"
# Public plan identities from execute-base-morpho-liquidation.js, not authority
# or runtime attestations. Compact Morpho reports omit the market and executor.
BASE_RUNNER_BINDINGS = {
    "base-b0-usde-usdc-0x6075": ("#B0", "0x60753e8622a6cfea1df449a9625a9778bb922b72", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b1-usde-usdc-0xb4fb": ("#B1", "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b2-usde-usdc-0x7bee": ("#B2", "0x7bee8d37fba61a6251a08b957d502c56e2a50fab", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b4-usde-usdc-0x7dcd": ("#B4", "0x7dcdb4ad4017f848879d17370aa6f32564e5cd08", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b5-usde-usdc-0x8986": ("#B5", "0x8986f93988d415abfb7b9bb700ccd3580c2f5298", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b6-usde-usdc-0xae0a": ("#B6", "0xae0a739c3724bb5cd2bdcf73764c87a5a6ec21a3", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b7-yousd-usdc-0x108b": ("#B7", ops.BASE_YOUSD_BORROWER, ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
    "base-b8-wsteth-weth-0x10c5": ("#B8", "0x10c53e75fe7a7e6bf58a9e68b6a30fcc7d4e6e2c", "0x6aa81f51dfc955df598e18006deae56ce907ac02b0b5358705f1a28fcea23cc0", BASE_EXECUTOR),
    "base-b9-weeth-weth-0x9558": ("#B9", "0x9558b339bb03246c44c57fcee184645dbfab253f", "0xfd0895ba253889c243bf59bc4b96fd1e06d68631241383947b04d1c293a0cfea", BASE_EXECUTOR),
    "base-b10-yousd-usdc-0xd406": ("#B10", "0xd406c93c8227ef08dc8ef0dfa027786bb85b756b", ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
    "base-b11-fluid48-susdai-usdc": ("#B11", "0x7e0371ec1177d3cf177a1a9a87dbc1e1864cd828", "0x59fa2f51f5c8fffceb538180ec47a869ec3dbd4a", BASE_UNIVERSAL_EXECUTOR),
    "base-b12-euler-wtspym-usdc": ("#B12", "0x17914d576bd7d14a14bdf187d1c72b194c61e358", "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e", BASE_EULER_EVK_EXECUTOR),
    "base-b13-euler-wtcoin-usdc": ("#B13", "0x17914d576bd7d14a14bdf187d1c72b194c61e35b", "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e", BASE_EULER_EVK_EXECUTOR),
    "base-b14-usde-usdc-0x6efc": ("#B14", "0x6efc48b8b6222924fa6ea95d174af5518b761177", ops.BASE_USDE_MARKET, BASE_EXECUTOR),
    "base-b15-yousd-usdc-0x5c2a": ("#B15", "0x5c2a8098c392fde0fa736e598ced595a9d6eb0b8", ops.BASE_YOUSD_MARKET, BASE_EXECUTOR),
}
M1_MARKET = "0xc581c5f70bd1afa283eed57d1418c6432cbff1d862f94eaf58fdd4e46afbb67f"
V3_USERS = {
    "0x7231eaeea108e3ea05c993cbee21f23ddd7a44bf", "0x1a557354c5b8d7df38ea914209e416dc7065b158",
    "0x4998ff53c34e25495c21652be7ce63b0e40b0995", "0xafbf278e06d2269aba2a4898afbab2ecb2584924",
    "0x00901e253a7e666687b2bfccfd8dde7be9fba4df", "0xd37505ca07d60a1d0e7a129efb245bb693034e89",
    "0xbc9d1be2a5609525efd9273cd254ef7c156ac33c", "0x1b5799899fce13c8ea3e22f1d825dbd22f3f7881",
    "0xaf6e0473f86360a91fc88564927372cdf999b8ad",
}
V3_2J_USER = "0x037a4486b28f0e3b34a4a6e7c4a915280e731a45"
SPARK_WHALE_BINDINGS = {
    "spark-wsteth-weth-0x4b28": ("#S1", "0x4b2877a94ead57e8a5e07b7b044eaeb59f605886"),
    "spark-wsteth-weth-0xf8f5": ("#S2", "0xf8f59620f260583e833d43a1940e6d210d0ce912"),
    "spark-wsteth-weth-0x0f8f": ("#S3", "0x0f8f3f27a9626de852cff35c9ed1a261131b70fe"),
    "spark-wsteth-weth-0x1964": ("#S4", "0x19647b0e6f6e3776378dac18047148d324472e02"),
}
V3_WHALE_BINDINGS = {
    "aave-v3-weth-weth-0x7a05": ("#2K", "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3"),
    "aave-v3-weth-weth-0xd185": ("#2L", "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a"),
    "aave-v3-weth-weth-0xf316": ("#2M", "0xf316d8b6fa4e13af2fbf51c0e17dd2742fb0dc2c"),
    "aave-v3-weeth-weth-0xee28": ("#2N", "0xee2826453a4fd5afeb7ceffeef3ffa2320081268"),
    "aave-v3-weeth-weth-0x5047": ("#2O", "0x5047e08c576778fffce5934ac658c80ada1fcc4c"),
    "aave-v3-weeth-weth-0x1d46": ("#2P", "0x1d46ce6b1d12b1ce9252034e9fb7a292db762e38"),
    "aave-v3-weeth-weth-0x5410": ("#2Q", "0x5410d09be697e57cd7c4ffa83759abed3219e020"),
}
SINGLES = {
    "target1_AaveV4_USDe_USDC": "target-1-aave-v4-usde-usdc",
    "target2A_AaveV3_weETH_WETH_0x7231": "target2a-aavev3-weeth-weth-0x7231",
    "target2B_AaveV3_weETH_WETH_0x1A55": "target2b-aavev3-weeth-weth-0x1a55",
    "target2J_AaveV3_wstETH_WETH_0x037a": "target2j-aavev3-wsteth-weth-0x037a",
    "targetS1_Spark_wstETH_WETH_0x4b28": "spark-wsteth-weth-0x4b28",
    "targetS2_Spark_wstETH_WETH_0xf8f5": "spark-wsteth-weth-0xf8f5",
    "targetS3_Spark_wstETH_WETH_0x0f8f": "spark-wsteth-weth-0x0f8f",
    "targetS4_Spark_wstETH_WETH_0x1964": "spark-wsteth-weth-0x1964",
    "target2K_AaveV3_WETH_WETH_0x7a05": "aave-v3-weth-weth-0x7a05",
    "target2L_AaveV3_WETH_WETH_0xd185": "aave-v3-weth-weth-0xd185",
    "target2M_AaveV3_WETH_WETH_0xf316": "aave-v3-weth-weth-0xf316",
    "target2N_AaveV3_weETH_WETH_0xee28": "aave-v3-weeth-weth-0xee28",
    "target2O_AaveV3_weETH_WETH_0x5047": "aave-v3-weeth-weth-0x5047",
    "target2P_AaveV3_weETH_WETH_0x1d46": "aave-v3-weeth-weth-0x1d46",
    "target2Q_AaveV3_weETH_WETH_0x5410": "aave-v3-weeth-weth-0x5410",
    "targetA3_AaveV4_USDe_USDC_0x1d9c": "target-a3-aave-v4-usde-usdc-0x1d9c",
    "targetA4_AaveV4_SameAsset_0xa429": "target-a4-aave-v4-same-asset-0xa429",
    "targetA5_AaveV4_syrupUSDG_USDG_0x080c": "target-a5-aave-v4-syrupusdg-usdg-0x080c",
    "targetA6_AaveV4_syrupUSDG_USDG_0xbd81": "target-a6-aave-v4-syrupusdg-usdg-0xbd81",
    "targetA7_AaveV4_syrupUSDG_USDG_0x28e8": "target-a7-aave-v4-syrupusdg-usdg-0x28e8",
    "targetA8_AaveV4_syrupUSDG_USDG_0x707e": "target-a8-aave-v4-syrupusdg-usdg-0x707e",
    "targetA9_AaveV4_syrupUSDG_USDG_0x90ff": "target-a9-aave-v4-syrupusdg-usdg-0x90ff",
    "targetA10_AaveV4_syrupUSDG_USDG_0x6efc": "target-a10-aave-v4-syrupusdg-usdg-0x6efc",
    "targetA11_AaveV4_USDe_USDC_0x5c43": "target-a11-aave-v4-usde-usdc-0x5c43",
    "targetA12_AaveV4_WBTC_USDT_0xac90": "target-a12-aave-v4-wbtc-usdt-0xac90",
    "targetA13_AaveV4_wstETH_WETH_0x4cd7": "target-a13-aave-v4-wsteth-weth-0x4cd7",
    "targetA14_AaveV4_syrupUSDG_USDG_0xabcc": "aave-v4-syrupusdg-usdg-0xabcc",
    "targetA15_AaveV4_weETH_WETH_0x3519": "aave-v4-weeth-weth-0x3519",
    "targetA16_AaveV4_syrupUSDG_USDG_0x9cd7": "aave-v4-syrupusdg-usdg-0x9cd7",
    "targetA17_AaveV4_weETH_WETH_0xa751": "aave-v4-weeth-weth-0xa751",
    "targetA18_AaveV4_syrupUSDG_USDG_0xdd64": "aave-v4-syrupusdg-usdg-0xdd64",
    "targetC9_AaveV4_weETH_WETH_0x9f46": "target-c9-aave-v4-weeth-weth-0x9f46",
    "targetM1_Morpho_USDe_DAI": "target-m1-morpho-usde-dai",
    "targetM2_Morpho_reUSD_USDC": "target-m2-morpho-reusd-usdc",
    "targetM7_Morpho_ynETHx_msETH_Canary": "target-m7-morpho-ynethx-mseth-canary",
    "targetM7B_Morpho_ynETHx_msETH_0x9b13": "target-m7b-morpho-ynethx-mseth-0x9b13",
    "targetYnEthx_Curve_NavArb": "target-ynethx-curve-navarb",
    "targetE1_EulerV2_RLUSD_USDC_0xbf21": "target-e1-euler-v2-rlusd-usdc-0xbf21",
    "targetE2_EulerV2_USDC_syrupUSDC_0x9f09": "target-e2-euler-v2-usdc-syrupusdc-0x9f09",
    "targetE3_EulerV2_WETH_ynETHx_0x831e": "target-e3-euler-v2-weth-ynethx-0x831e",
    "targetE4_EulerV2_WETH_ynETHx_0x8062": "target-e4-euler-v2-weth-ynethx-0x8062",
    "targetE5_EulerV2_USDC_USDT_0xd1ed": "target-e5-euler-v2-usdc-usdt-0xd1ed",
    "targetE6_EulerV2_USDT_USDC_0x079d": "target-e6-euler-v2-usdt-usdc-0x079d",
    "targetE7_EulerV2_RLUSD_USDe_0x1066": "euler-rlusd-usde-e7",
    "targetE8_Euler_eUSDC2_eXAUt1": "euler-eusdc2-exaut1-e8",
    "targetE9_Euler_eUSDT9_eUSDC22": "euler-eusdt9-eusdc22-e9",
    "targetE10_Euler_eRLUSD7_eUSDC70": "euler-erlusd7-eusdc70-e10",
    "targetM8_Morpho_PT_USDe_DAI": "target-m8-morpho-pt-usde-dai",
    "targetM9_Morpho_PT_USDe_DAI": "target-m9-morpho-pt-usde-dai",
    "targetM10_Morpho_USDe_RLUSD": "target-m10-morpho-usde-rlusd",
    "targetM11_Morpho_weETH_WETH": "target-m11-morpho-weeth-weth",
    "targetM12_Morpho_PT_USD3_USDC": "target-m12-morpho-pt-usd3-usdc",
    "targetM13_Morpho_PT_USD3_USDC": "target-m13-morpho-pt-usd3-usdc",
    "targetM14_Morpho_PT_USDat_USDC": "target-m14-morpho-pt-usdat-usdc",
    "targetM15_Morpho_yoUSD_Edge_USDC": "target-m15-morpho-yousd-edge-usdc",
    "targetM16_Morpho_apyUSD_apxUSD": "target-m16-morpho-apyusd-apxusd",
    "targetM17_Morpho_eUSDe_USDe": "morpho-eusde-usde-m17",
    "targetM18_Morpho_USD3_USDC": "morpho-usd3-usdc-m18",
    "targetM19_Morpho_USD3_USDC": "morpho-usd3-usdc-m19",
    "targetM20_Morpho_USD3_USDC": "morpho-usd3-usdc-m20",
    "targetM21_Morpho_PT_apyUSD_apxUSD": "morpho-pt-apyusd-apxusd-m21",
    "targetM22_Morpho_PT_apyUSD_apxUSD": "morpho-pt-apyusd-apxusd-m22",
    "targetM23_Morpho_PT_reUSD_USDC": "morpho-pt-reusd-usdc-m23",
    "targetM24_Morpho_PT_reUSD_USDC": "morpho-pt-reusd-usdc-m24",
    "targetM25_Morpho_USD3_USDC": "morpho-usd3-usdc-m25",
    "targetM26_Morpho_USD3_USDC": "morpho-usd3-usdc-m26",
    "targetM27_Morpho_PT_reUSD_USDC": "morpho-pt-reusd-usdc-m27",
    "targetM28_Morpho_PT_reUSD_USDC": "morpho-pt-reusd-usdc-m28",
    "targetM29_Morpho_PT_srUSDe_USDC": "morpho-pt-srusde-usdc-m29",
    "targetM30_Morpho_wstETH_WETH": "morpho-wsteth-weth-m30",
    "targetM31_Morpho_syrupUSDC_USDC": "morpho-syrupusdc-usdc-m31",
    "targetM32_Morpho_sUSDe_USDtb": "morpho-susde-usdtb-m32",
    "targetF1_Fluid_USDe_USDT_Vault93": "fluid-usde-usdt-f1",
    "targetF2_Fluid_eBTC_cbBTC_Vault96": "fluid-ebtc-cbbtc-f2",
    "targetF3_Fluid_ETH_osETH_Vault159": "fluid-eth-oseth-f3",
    "targetF4_Fluid_PAXG_XAUt_Vault123": "fluid-paxg-xaut-f4",
    "targetF5_Fluid_WBTC_LBTC_Vault115": "fluid-wbtc-lbtc-f5",
    "targetF6_Fluid_syrupUSDC_USDC_Vault145": "fluid-syrupusdc-usdc-f6",
    "targetM33_Morpho_PT_reUSD_USDT": "morpho-pt-reusd-usdt-m33",
    "targetM34_Morpho_beraSTONE_WETH": "morpho-berastone-weth-m34",
    "targetM35_Morpho_PT_USD3_USDC": "morpho-pt-usd3-usdc-m35",
    "targetM36_Morpho_sUSDS_USDT": "morpho-susds-usdt-m36",
    "targetM37_Morpho_PST_USDT": "morpho-pst-usdt-m37",
    "targetM38_Morpho_sUSDS_USDT": "morpho-susds-usdt-m38",
    "targetM39_Morpho_reUSD_USDC": "morpho-reusd-usdc-m39",
    "targetM40_Morpho_weETH_WETH": "morpho-weeth-weth-m40",
    "targetM41_Morpho_wstETH_WETH": "morpho-wsteth-weth-m41",
    "targetM42_Morpho_strUSD_USDC": "morpho-strusd-usdc-m42",
    "targetM43_Morpho_PRIME_PYUSD": "morpho-prime-pyusd-m43",
    "targetM44_Morpho_srUSD_USDC": "morpho-srusd-usdc-m44",
    "targetM45_Morpho_reUSDe_USDC": "morpho-reusde-usdc-m45",
    "targetM46_Morpho_apyUSD_apxUSD": "morpho-apyusd-apxusd-m46",
    "targetM47_Morpho_USDe_RLUSD": "morpho-usde-rlusd-m47",
    "targetM48_Morpho_reUSD_USDT": "morpho-reusd-usdt-m48",
    "targetM49_Morpho_sUSDe_USDT": "morpho-susde-usdt-m49",
    "targetB11_Fluid_sUSDai_USDC_Vault48": "fluid-susdai-usdc-b11",
    "targetB12_EulerV2_wtSPYM_USDC_0x1791": "euler-wtspym-usdc-b12",
    "targetB13_EulerV2_wtCOIN_USDC_0x1791": "euler-wtcoin-usdc-b13",
    "targetB14_Base_USDe_USDC_0x6efc": "base-usde-usdc-b14",
    "targetB15_Base_yoUSD_USDC_0x5c2a": "base-yousd-usdc-b15",
    "targetM2B_Morpho_reUSD_USDC": "target-m2b-morpho-reusd-usdc",
    "targetM2C_Morpho_reUSD_USDC": "target-m2c-morpho-reusd-usdc",
    "targetM2D_Morpho_reUSD_USDC": "target-m2d-morpho-reusd-usdc",
    "targetB0_Base_USDe_USDC": "target-b0-base-usde-usdc",
    "target3_Morpho_PAXG_USDC": "target-3-morpho-paxg-usdc",
}
ARRAYS = {"additional_AaveV3_weETH_WETH": (7, "aave-v3-extra"),
          "extra_Base_USDe_Whales": (7, "base-usde-extra"),
          "spokeC_AaveV4_weETH_WETH": (8, "spoke-c"), "morpho_wstETH_WETH_Whales": (4, "morpho-wsteth"), "base_Morpho_Whales": (3, "base-morpho")}
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,36})?")
ADDRESS_FIELDS = {"user", "borrower", "spoke", "pool", "deployedExecutor", "executor", "liquidatorAddress", "contractAddress", "owner", "onchainOwner"}
DATE_FIELDS = {"generatedAt", "checkedAt", "deployedAt", "recordedAt", "utc", "observationUtc"}
INTEGER_FIELDS = {"chainId", "number", "blockNumber", "observationBlock", "candidateCount", "firedCount", "deployedCodeBytes", "deployedBytecodeBytes"}
BOOL_FIELDS = {"ok", "armed", "executableNow", "eligibleForPreflight", "hfUnderwaterNow", "liquidatableNow", "isLiquidatableBothProviders", "twoProvidersAgreed", "healthIsEstimate", "inactive"}
NUMBER_FIELDS = {
    "healthFactor", "healthFactorRaw", "healthFactorFormatted", "bpsToLiquidation", "collateralUsd", "debtUsd", "debtUsdc",
    "collateralValueUsdc", "borrowAprPct", "passiveHoursToCrossing", "hoursUntil24hHeartbeat", "availableUsdc",
    "repayUsdc", "seizedUsde", "uniV3OutUsdc", "grossSurplusUsdc", "repayWeth", "seizedWeEth", "curveOutWeth",
    "grossSurplusWeth", "grossSurplusUsd", "repayDai", "uniV3OutDai", "grossSurplusDai", "gasUsed", "actualFeeEth",
    "actualDeployFeeEth", "actualDeployFeeUsdApprox", "ownerEthBalanceAfterFormatted", "ownerUsdcGainFormatted",
    "ownerWethGainFormatted", "ownerWethGainUsdApprox", "block", "seizedReusd", "curveOutUsdc", "storedHealthFactor",
    "seizedWstEth", "uniV3OutWeth", "ynEthxBufferWeth", "estimatedProfitUsd", "collateralPt",
}
RUNNER_REASONS = {"NEXT_BLOCK_PROVIDER_DISAGREEMENT": "Shared runner blocked: provider disagreement."}
CURRENT_2K_TARGET = "target2K_AaveV3_WETH_WETH_0x7a05"
CURRENT_2K_SCOPE = "CURRENT_2K_ONLY"
CURRENT_2K_2L_SCOPE = "CURRENT_2K_2L_ONLY"
CURRENT_2K_2L_TARGETS = (CURRENT_2K_TARGET, "target2L_AaveV3_WETH_WETH_0xd185")
# Sanitized partition names are not all broad unified-runner membership grants.
BROAD_UNIFIED_PARTITIONS = {"V3_ONLY", "V3_AND_EXPLICIT_V4_WETH", "AAVE_V3_ONLY"}
ENUMS = {
    "reason": set(RUNNER_REASONS),
    "schema": {"top-whale-triggers-status/v1", "fork-poc/v1"},
    "status": {"COMPLETE", "INCOMPLETE", "UNAVAILABLE", "PASS", "DEPLOYED_AND_TWO_PROVIDER_VERIFIED", "MULTI_SPOKE_LOCAL_FORK_REHEARSAL_PASS"},
    "observationStatus": {"COMPLETE", "INCOMPLETE", "UNAVAILABLE"},
    "refreshStatus": {"COMPLETE", "INCOMPLETE", "UNAVAILABLE"},
    "provenance": {"ONCHAIN_MEASURED", "MODEL_ESTIMATE", "HISTORICAL_REFERENCE"},
    "positionStatus": {"OPEN", "CLOSED", "UNKNOWN"},
    "debtReadStatus": {"COMPLETE", "UNAVAILABLE"},
    "debtReadKind": {"MORPHO_BORROW_SHARES", "EULER_DEBT_ASSETS"},
    "bufferReadStatus": {"OK", "READ_FAILED"},
    "mode": {"EXECUTE_IF_LIQUIDATABLE", "CHECK_ONLY", "WATCH", "BLOCKED"},
    "partition": BROAD_UNIFIED_PARTITIONS | {CURRENT_2K_SCOPE, CURRENT_2K_2L_SCOPE},
    "collectionScope": {CURRENT_2K_SCOPE, CURRENT_2K_2L_SCOPE},
    "targetId": set(CURRENT_2K_2L_TARGETS),
    "morphoExecution": {"M1_USDE_DAI_ARMED; PAXG_DISABLED", "DISABLED_OBSERVATION_ONLY"},
    "pair": {"USDe / USDC (Base)", "yoUSD / USDC (Base)", "mGLO / USDC (Base)", "USDe / USDC", "WETH / USDC (Same-Asset)", "weETH / WETH", "wstETH / WETH", "USDe / DAI", "reUSD / USDC", "ynETHx / msETH", "PT-USDe-31JUL2025 / DAI", "WETH -> ynETHx -> Redeem (Curve/NAV)", "eUSDC-22 / eRLUSD-1 (Euler V2)", "esyrupUSDC-4 / eUSDC-70 (Euler V2)", "eynETHx-2 / eWETH-22 (Euler V2)", "eUSDT-9 / eUSDC-22 (Euler V2)", "eUSDC-22 / eUSDT-9 (Euler V2)"},
    "rank": {"#1", "#A3", "#A4", "#2A", "#2B", "#2J", "#M1", "#M2", "#M3", "#M4", "#M5", "#M6", "#M7", "#M7B", "#M8", "#M9", "#YN", "#E1", "#E2", "#E3", "#E4", "#E5", "#E6", "#B0", "#B1", "#B2", "#B3", "#B4", "#B5", "#B6", "#B7", *(f"#C{i}" for i in range(1, 9)), *(f"#2{c}" for c in "CDEFGHI")},
    "id": {"spokeA-candidate1-usde-usdc", "spokeC-c1-weeth-weth-0x4053", "spokeC-c2-weeth-weth-0xafbf",
           "spokeC-candidate3-weeth-weth", "spokeC-c4-weeth-weth-0xfcc8", "spokeC-candidate4-weeth-weth",
           "spokeC-c6-weeth-weth-0xba48", "spokeC-c7-weeth-weth-0xc99f", "spokeC-c8-weeth-weth-0x4b98"},
    "label": {"deployGasUsed", "baseUsdeRehearsalResults"},
}
OBJECT_FIELDS = {"pin", "baseObservation", "debtObservation", "liveQuote", "bytecodeVerification", "rehearsalSpokeA_UsdeUsdc_UniV3", "rehearsalSpokeC_WeethWeth_CurveNG"}
ENUMS["rank"].update(ARB_ALL_BINDINGS)
ENUMS["pair"].update(binding[2] for binding in ARB_ALL_BINDINGS.values())
ENUMS["rank"].update({"#ARB5", "#ARB6", "#ARB7"})
ENUMS["pair"].update(metadata[1] for metadata in _ARB_METADATA.values())
ENUMS["id"].update({ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID})
ENUMS["id"].update(ARB_SINGLES.values())
ENUMS["id"].update(SINGLES[key] for key in CURRENT_2K_2L_TARGETS)
ENUMS["pair"].update({"syrupUSDG / USDG (UniV4)", "syrupUSDC / USDC", "sUSDe / USDtb", "WBTC / USDT (UniV4)", "USDe / RLUSD", "PT-USD3-17DEC2026 / USDC", "PT-USDat-27AUG2026 / USDC", "yoUSD Edge / USDC", "apyUSD / apxUSD", "eUSDe / USDe", "USD3 / USDC", "PT-apyUSD-5NOV2026 / apxUSD", "PT-reUSD-10DEC2026 / USDC", "PT-srUSDe-15JAN2026 / USDC", "wstETH / WETH (Base)", "weETH / WETH (Base)"})
ENUMS["rank"].update({"#A5", "#A6", "#A7", "#A8", "#A9", "#A10", "#A11", "#A12", "#A13", "#C9", "#B8", "#B9", "#B10", "#M10", "#M11", "#M12", "#M13", "#M14", "#M15", "#M16", "#M17", "#M18", "#M19", "#M20", "#M21", "#M22", "#M23", "#M24", "#M25", "#M26", "#M27", "#M28", "#M29", "#M30", "#M31", "#M32", "#M2B", "#M2C", "#M2D"})
ENUMS["rank"].update({"#A14", "#A15", "#A16", "#A17", "#A18"})
ENUMS["rank"].update(binding[0] for binding in V3_WHALE_BINDINGS.values())
ENUMS["rank"].update(binding[0] for binding in SPARK_WHALE_BINDINGS.values())
ENUMS["pair"].add("wstETH / WETH (SparkLend)")
ENUMS["pair"].add("WETH / WETH (Same-Asset)")
ENUMS["rank"].update({"#F1", "#F2", "#F3", "#F4", "#F5", "#F6", "#M33", "#M34", "#M35", "#M36", "#M37", "#M38", "#M39", "#M40", "#M41", "#M42", "#M43", "#M44", "#M45", "#M46", "#M47", "#M48", "#M49", "#B11", "#B12", "#B13", "#B14", "#B15", "#E7", "#E8", "#E9", "#E10"})
ENUMS["pair"].update({"eUSDC-2 / eXAUt-1", "eUSDT-9 / eUSDC-22", "eRLUSD-7 / eUSDC-70"})
ENUMS["pair"].update({"strUSD / USDC", "PRIME / PYUSD", "srUSD / USDC", "reUSDe / USDC", "reUSD / USDT", "sUSDe / USDT"})
ENUMS["pair"].update({"USDe-USDT / USDT (Fluid T2)", "eBTC-cbBTC / WBTC (Fluid T2)", "ETH-osETH / wstETH (Fluid T2)", "PAXG-XAUt / USDT (Fluid T2)", "WBTC-LBTC / WBTC (Fluid T2)", "syrupUSDC-USDC / USDC (Fluid T2)", "PT-reUSD-10DEC2026 / USDT", "beraSTONE / WETH", "sUSDS / USDT", "PST / USDT", "sUSDai-USDC / USDC (Base Fluid T2)", "ewtSPYM-2 / eUSDC-49 (Base Euler V2)", "ewtCOIN-2 / eUSDC-49 (Base Euler V2)", "eUSDe-6 / eRLUSD-1 (Euler V2)"})

DEBT_STATUS_BINDINGS = {
    SINGLES["targetB14_Base_USDe_USDC_0x6efc"]: (8453, "0x6efc48b8b6222924fa6ea95d174af5518b761177", ops.BASE_USDE_MARKET, "MORPHO_BORROW_SHARES"),
    SINGLES["targetM34_Morpho_beraSTONE_WETH"]: (1, "0x52426c8065974821e99fa3c9aad73e47b9f1d6fc", "0xf78b7d3a62437f78097745a5e3117a50c56a02ec5f072cba8d988a129c6d4fb6", "MORPHO_BORROW_SHARES"),
    SINGLES["targetE8_Euler_eUSDC2_eXAUt1"]: (1, "0x3a8306fb4fa0811a86955f4421600e3b500a9e44", "0x797dd80692c3b2dadabce8e30c07fde5307d48a9", "EULER_DEBT_ASSETS"),
}
CLOSED_POSITION_NOTE = "No outstanding debt at observed block"


def _position_debt_status(ident: str, raw: dict, pinned: dict) -> str | None:
    binding = DEBT_STATUS_BINDINGS.get(ident)
    if binding is None or raw.get("observationStatus") in {"INCOMPLETE", "UNAVAILABLE"}:
        return None
    chain, user, market, kind = binding
    proof = raw.get("debtObservation") or {}
    if (raw.get("user") != user or raw.get("marketId") != market
            or raw.get("chainId", chain) != chain or raw.get("debtReadKind") != kind
            or raw.get("debtReadStatus") != "COMPLETE" or not isinstance(raw.get("debtRaw"), str)
            or re.fullmatch(r"(?:0|[1-9][0-9]{0,77})", raw["debtRaw"]) is None
            or int(raw["debtRaw"]) >= 2**256):
        return None
    if (proof.get("chainId") != chain or pinned.get("chainId") != chain
            or not all(proof.get(k) is not None and proof.get(k) == pinned.get(k) for k in ("number", "hash", "utc"))
            or ("timestamp" in proof and timestamp(proof.get("utc")) != proof["timestamp"])
            or ("timestamp" in pinned and timestamp(pinned.get("utc")) != pinned["timestamp"])):
        return None
    closed = raw["debtRaw"] == "0"
    expected = "CLOSED" if closed else "OPEN"
    return expected if raw.get("positionStatus") == expected and raw.get("inactive") is closed else None


def _amount(value: Any, *, signed: bool = False) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str):
        if len(value) > 115 or DECIMAL.fullmatch(value) is None:
            return None
    elif isinstance(value, float) and not math.isfinite(value):
        return None
    elif isinstance(value, int) and value.bit_length() > 256:
        return None
    number = Decimal(str(value))
    if abs(number) > Decimal("1e60") or (number < 0 and not signed):
        return None
    text = format(number, "f")
    if len(text) > 115:
        return None
    return (text.rstrip("0").rstrip(".") if "." in text else text) if number else "0"


def _buffer_raw(value: Any) -> str | None:
    return value if (type(value) is str and len(value) <= 78
                     and re.fullmatch(r"(?:0|[1-9][0-9]*)", value)
                     and int(value) < 2**256) else None


def _number(value: Any, *, signed: bool = False) -> float | None:
    value = _amount(value, signed=signed)
    return float(value) if value is not None else None


def _address(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and ops.ADDRESS.fullmatch(value) else None


def _hash(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and HASH.fullmatch(value) else None


def _clean(value: Any, depth: int = 0) -> dict[str, Any]:
    """Whitelist before calling the legacy presentation adapter; no raw free text."""
    if not isinstance(value, dict) or depth > 5:
        return {}
    out = {}
    for key, item in value.items():
        if key in ADDRESS_FIELDS:
            out[key] = _address(item)
        elif key == "marketId":
            out[key] = _hash(item) or _address(item)
        elif key in {"hash", "txHash", "observationHash"}:
            out[key] = _hash(item)
        elif key in DATE_FIELDS:
            out[key] = ops._iso(item)
        elif key == "timestamp":
            # The pinned runners emit integer Unix seconds, not milliseconds or strings.
            out[key] = item if ops._bounded_int(item, 9_999_999_999) and item > 0 else None
        elif key in INTEGER_FIELDS:
            out[key] = item if ops._bounded_int(item, 10**12) else None
        elif key in BOOL_FIELDS:
            out[key] = (item is not False) if key == "healthIsEstimate" else item if isinstance(item, bool) else None
        elif key in NUMBER_FIELDS:
            out[key] = item if _amount(item, signed=key == "bpsToLiquidation" or key.startswith("grossSurplus")) is not None else None
        elif key == "debtRaw":
            out[key] = item if isinstance(item, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,77})", item) and int(item) < 2**256 else None
        elif key == "bufferMaxWithdrawWeth":
            out[key] = _buffer_raw(item)
        elif key in ENUMS:
            out[key] = item if isinstance(item, str) and item in ENUMS[key] else None
        elif key in OBJECT_FIELDS or key in SINGLES:
            out[key] = _clean(item, depth + 1)
        elif key in ARRAYS and isinstance(item, list):
            out[key] = [_clean(v, depth + 1) for v in item[:ARRAYS[key][0]]]
        elif key == "targets":
            # Reject an oversized watch list rather than hiding an ambiguous
            # duplicate beyond the nine curated dedicated targets.
            out[key] = ([_clean(v, depth + 1) for v in item] if len(item) <= 9 else []) if isinstance(item, list) else _clean(item, depth + 1)
        elif key == "observations" and isinstance(item, list):
            out[key] = [_clean(v, depth + 1) for v in item[:32] if isinstance(v, dict) and isinstance(v.get("label"), str) and v["label"] in ENUMS["label"]]
        elif key == "value":
            out[key] = [_clean(v, depth + 1) for v in item[:3]] if isinstance(item, list) else _amount(item)
        elif key in {"readyExecuteMorphoCalldata", "readyExecuteMorphoBlueCalldata", "readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata", "readyExecuteUniversalCalldata", "readyExecuteVaultRedeemCalldata", "readyExecuteEulerEvkCalldata", "readyExecuteUniV4FlashCalldata", "readyExecutePendlePtCalldata"}:
            out[key] = item if isinstance(item, str) and re.fullmatch(r"0x(?:[0-9a-fA-F]{2}){1,32768}", item) else None
    return out


def _arb_morpho_pin(value: Any) -> dict:
    if not isinstance(value, dict) or value.get("chainId", 42161) != 42161:
        return {}
    seconds = value.get("timestamp")
    if "timestamp" in value and (not ops._bounded_int(seconds, 9_999_999_999) or seconds <= 0):
        return {}
    utc = ops._iso(value.get("utc")) if value.get("utc") is not None else ops._iso(seconds)
    if utc is None or ("timestamp" in value and timestamp(utc) != seconds):
        return {}
    return {**_clean(value), "chainId": 42161, "utc": utc}


def _arb_morpho_row(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    rank = value.get("rank")
    if value.get("id") in (ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID) or rank in ("#ARB5", "#ARB6", "#ARB7"):
        ident = ARB_FLUID_42_ID if value.get("id") == ARB_FLUID_42_ID or rank == "#ARB7" else ARB_FLUID_54_ID if value.get("id") == ARB_FLUID_54_ID or rank == "#ARB6" else ARB_FLUID_ID
        expected_rank, pair, vault, *_ = _ARB_METADATA[ident]
        if (value.get("id", ident) != ident or rank not in (None, expected_rank)
                or _address(value.get("marketId", value.get("fluidVault"))) != vault):
            return None
        if ident == ARB_FLUID_42_ID and _address(value.get("borrower")) != ARB_FLUID_42_BORROWER:
            return None
        return _clean({
            "id": ident, "rank": expected_rank, "pair": pair, "marketId": vault,
            "user": ARB_FLUID_42_BORROWER if ident == ARB_FLUID_42_ID else None, "executor": value.get("executor", ARB_FLUID_EXECUTOR),
            "healthFactor": value.get("healthFactor"), "bpsToLiquidation": value.get("bpsToLiquidation"),
            "liquidatableNow": value.get("isLiquidatable"), "debtUsd": value.get("debtStableUsd"),
            "collateralUsd": value.get("collateralValueUsd"),
            "passiveHoursToCrossing": value.get("passiveHoursToCrossing"),
        })
    if not isinstance(rank, str) or rank not in ARB_ALL_BINDINGS:
        return None
    borrower, market, pair = ARB_ALL_BINDINGS[rank]
    if _address(value.get("borrower")) != borrower or _hash(value.get("marketId")) != market:
        return None
    if rank in ARB_SINGLES and value.get("id", ARB_SINGLES[rank]) != ARB_SINGLES[rank]:
        return None
    return _clean({
        "id": ARB_SINGLES.get(rank), "executor": value.get("executor"),
        "liveQuote": value.get("liveQuote") if rank in ARB_SINGLES else None,
        "rank": rank, "pair": pair, "user": borrower, "marketId": market,
        "healthFactor": value.get("healthFactor"), "bpsToLiquidation": value.get("bpsToLiquidation"),
        "liquidatableNow": value.get("isLiquidatable"), "debtUsd": value.get("debtStableUsd"),
        "collateralUsd": value.get("collateralValueUsd"),
        "passiveHoursToCrossing": value.get("passiveHoursToCrossing"),
    })


def _observation(pin: Any, at: Any, now: float, chain: int, source: str, complete: bool = True) -> dict[str, Any]:
    pin = pin if isinstance(pin, dict) else {}
    block = pin.get("number") if ops._bounded_int(pin.get("number"), 10**12) and pin["number"] > 0 else None
    utc, digest = ops._iso(pin.get("utc")), _hash(pin.get("hash"))
    if pin.get("chainId") != chain:
        block = utc = digest = None
    fresh, age = ops._freshness_view(at, now)
    pin_fresh, pin_age = ops._freshness_view(utc, now)
    if pin.get("chainId") != chain or block is None or utc is None or digest is None or not complete:
        fresh, age = UNKNOWN, None  # A recent attempt is not a successful health pin.
    elif fresh not in {FRESH, AGING, STALE} or pin_fresh not in {FRESH, AGING, STALE}:
        fresh, age = UNKNOWN, pin_age
    else:
        age = max(age, pin_age)
        fresh = ops._freshness_view(now - age, now)[0]
    return {"freshness": fresh, "age_text": ops._age_text(age), "block": block, "hash": digest, "utc": utc, "source": source}


def _row_observation(raw: dict, pin: dict, at: Any, now: float, chain: int, source: str, complete: bool = True) -> dict:
    """A reused row keeps its original pin, never the latest document's pin."""
    fields = {"observationBlock": "number", "observationHash": "hash", "observationUtc": "utc"}
    if any(key in raw for key in fields):
        pin = {"chainId": chain, **{dest: raw.get(key) for key, dest in fields.items()}}
    return _observation(pin, at, now, chain, source,
                        complete and raw.get("observationStatus") not in {"INCOMPLETE", "UNAVAILABLE"}
                         and raw.get("refreshStatus") not in {"INCOMPLETE", "UNAVAILABLE"})


def _buffer_capacity(raw: dict, pin: dict, at: Any, now: float, complete: bool) -> dict:
    # This display-only quantity is assets redeemable by the shared ynETHx holder,
    # not the misnamed legacy share balance, a quote, or execution readiness.
    row_pin = any(key in raw for key in ("observationBlock", "observationHash", "observationUtc"))
    coherent = (raw.get("chainId", 1) == 1 and (row_pin or "timestamp" not in pin
                or (pin["timestamp"] is not None and timestamp(pin.get("utc")) == pin["timestamp"])))
    obs = _row_observation(raw, pin, at, now, 1, SENTINEL, complete and coherent)
    amount_raw = _buffer_raw(raw.get("bufferMaxWithdrawWeth"))
    status = raw.get("bufferReadStatus")
    available = bool(status == "OK" and amount_raw is not None and obs["freshness"] in {FRESH, AGING, STALE})
    status = "READ_FAILED" if status == "READ_FAILED" else "OK" if available else "UNKNOWN"
    digits = amount_raw.zfill(19) if available else None
    return {
        "available": available, "read_status": status,
        "amount_raw": amount_raw if available else None,
        "amount": digits[:-18] + "." + digits[-18:] if digits is not None else None,
        "symbol": "WETH", "decimals": 18, "scope": "SHARED_YNETHX_HOLDER",
        "legacy_shares": _amount(raw.get("ynEthxBufferWeth")),
        "legacy_shares_unit": "MCwETH shares", "legacy_shares_rounded": True,
        "observation": obs,
        "note": "Shared holder-specific ordinary redemption capacity; not global cash or NAV and not additive across these targets.",
    }


def _quote_evidence(raw: dict, obs: dict) -> tuple[str, bool]:
    """Only explicit, matching measured provenance can describe a current quote."""
    q = raw.get("liveQuote")
    q = q if isinstance(q, dict) else {}
    kind = q.get("provenance")
    kind = kind if isinstance(kind, str) and kind in ENUMS["provenance"] else "UNKNOWN"
    matched = all(q.get(p) is not None and q.get(p) == obs.get(o)
                  for p, o in (("observationBlock", "block"), ("observationHash", "hash"), ("observationUtc", "utc")))
    row_matches = all(raw.get(k) is None or raw[k] == obs.get(p)
                      for k, p in (("observationBlock", "block"), ("observationHash", "hash"), ("observationUtc", "utc")))
    return kind, bool(kind == "ONCHAIN_MEASURED" and matched and row_matches and obs.get("freshness") == FRESH
                      and raw.get("observationStatus") not in {"INCOMPLETE", "UNAVAILABLE"}
                      and raw.get("refreshStatus") not in {"INCOMPLETE", "UNAVAILABLE"})


def _quote(raw: dict, obs: dict, kind: str) -> dict:
    q = raw.get("liveQuote") or {}
    keys = {"usdc": ("grossSurplusUsdc", "USDC", "repayUsdc", "seizedUsde", "USDe", "uniV3OutUsdc"),
            "syrup-usdg": ("grossSurplusUsdc", "USDG", "repayUsdc", "seizedUsde", "syrupUSDG", "uniV3OutUsdc"),
            "wbtc-usdt": ("grossSurplusUsdc", "USDT", "repayUsdc", "seizedUsde", "WBTC", "uniV3OutUsdc"),
            "same-asset-usdc": ("grossSurplusUsdc", "USDC", "repayUsdc", "seizedUsde", "USDC", "uniV3OutUsdc"),
            "yousd": ("grossSurplusUsdc", "USDC", "repayUsdc", "seizedUsde", "yoUSD", "uniV3OutUsdc"),
            "reusd": ("grossSurplusUsdc", "USDC", "repayUsdc", "seizedReusd", "reUSD", "curveOutUsdc"),
            "weth": ("grossSurplusWeth", "WETH", "repayWeth", "seizedWeEth", "weETH", "curveOutWeth"),
            "wsteth": ("grossSurplusWeth", "WETH", "repayWeth", "seizedWstEth", "wstETH", "uniV3OutWeth"),
            "dai": ("grossSurplusDai", "DAI", "repayDai", "seizedUsde", "USDe", "uniV3OutDai")}
    basis, measured = _quote_evidence(raw, obs)
    result = {"available": False, "provenance": basis, "estimate": None, "gross_token_amount": None, "gross_token_symbol": None, "gross_usd": None,
              "repay_amount": None, "repay_symbol": None, "seize_amount": None, "seize_symbol": None,
              **{k: obs[k] for k in ("freshness", "age_text", "block", "hash", "utc", "source")}, "notes": []}
    # A quote's pin belongs to the quote, not the current document or health row.
    quote_pin = {"block": q.get("observationBlock"), "hash": q.get("observationHash"), "utc": q.get("observationUtc")}
    if not all(value is not None and value == obs.get(key) for key, value in quote_pin.items()):
        result.update(freshness=UNKNOWN, age_text=None)
    result.update(quote_pin)
    if raw.get("rank") == "#M32" and not q:
        # Legacy M2 quotes are stripped before reaching this projection.
        result.update(freshness=UNKNOWN, age_text=None, block=None, hash=None, utc=None, source=None,
                      gross_token_symbol="USDtb", repay_symbol="USDtb", seize_symbol="sUSDe",
                      notes=["Current quote unavailable; health telemetry is not an eligible execution quote.",
                             "Historical local-fork estimates are shown separately, not as current profit."])
        return result
    if kind not in keys:
        estimate = _amount(q.get("estimatedProfitUsd"), signed=True)
        if estimate is not None and kind != "observation":
            result["estimate"] = {"gross_usd": estimate, "gross_token_amount": None, "gross_token_symbol": None,
                                  "label": "Model estimate · not a current quote", "provenance": basis}
        result["notes"] = ["Conditional M7 rehearsal estimates are not a current live profit quote." if kind == "mseth" else "Observation only; market liquidity and rehearsal gains are not a live profit quote."]
        return result
    gross, symbol, repay, seize, collateral, output = keys[kind]
    if kind == "weth" and raw.get("rank") in {"#2K", "#2L", "#2M"}:
        collateral = "WETH"
    if kind == "reusd" and raw.get("rank") in {"#F1", "#M33"}:
        symbol = "USDT"
        collateral = "USDe-USDT LP" if raw["rank"] == "#F1" else "PT-reUSD"
    elif kind == "reusd" and raw.get("rank") == "#F2":
        symbol = "WBTC"
        collateral = "eBTC-cbBTC LP"
    elif kind == "reusd" and raw.get("rank") == "#F3":
        symbol = "wstETH"
        collateral = "ETH-osETH LP"
    elif kind == "reusd" and raw.get("rank") == "#F4":
        symbol = "USDT"
        collateral = "PAXG-XAUt LP"
    elif kind == "reusd" and raw.get("rank") == "#F5":
        symbol = "WBTC"
        collateral = "WBTC-LBTC LP"
    elif kind == "reusd" and raw.get("rank") == "#F6":
        symbol = "USDC"
        collateral = "syrupUSDC-USDC LP"
    elif kind == "reusd" and raw.get("rank") in {"#M12", "#M35"}:
        symbol = "USDC"
        collateral = "PT-USD3"
    elif kind == "reusd" and raw.get("rank") in {"#M36", "#M38"}:
        symbol = "USDT"
        collateral = "sUSDS"
    elif kind == "reusd" and raw.get("rank") == "#M37":
        symbol = "USDT"
        collateral = "PST"
    elif kind == "reusd" and raw.get("rank") in {"#M42", "#M44"}:
        symbol = "USDC"
        collateral = "strUSD" if raw["rank"] == "#M42" else "srUSD"
    elif kind == "reusd" and raw.get("rank") == "#M45":
        symbol = "USDC"
        collateral = "reUSDe"
    elif kind == "reusd" and raw.get("rank") == "#M46":
        symbol = "apxUSD"
        collateral = "apyUSD"
    elif kind == "reusd" and raw.get("rank") == "#M47":
        symbol = "RLUSD"
        collateral = "USDe"
    elif kind == "reusd" and raw.get("rank") in {"#M48", "#M49"}:
        symbol = "USDT"
        collateral = "reUSD" if raw["rank"] == "#M48" else "sUSDe"
    elif kind == "reusd" and raw.get("rank") == "#M32":
        symbol = "USDtb"
        collateral = "sUSDe"
    elif kind == "reusd" and raw.get("rank") == "#M43":
        symbol = "PYUSD"
        collateral = "PRIME"
    elif kind == "reusd" and raw.get("rank") == "#M34":
        symbol = "WETH"
        collateral = "beraSTONE"
    elif kind == "reusd" and raw.get("rank") == "#B11":
        symbol = "USDC"
        collateral = "sUSDai-USDC LP"
    elif kind == "reusd" and raw.get("rank") in {"#B12", "#B13"}:
        symbol = "USDC"
        collateral = "wtCOIN" if raw["rank"] == "#B13" else "wtSPYM"
    elif kind == "reusd" and raw.get("rank") in {"#B14", "#B15"}:
        symbol = "USDC"
        collateral = "USDe" if raw["rank"] == "#B14" else "yoUSD"
    elif kind == "wsteth" and raw.get("rank") == "#M40":
        collateral = "weETH"
    elif kind == "reusd" and raw.get("rank") == "#E7":
        symbol = "RLUSD"
        collateral = "eUSDe-6"
    elif kind == "reusd" and raw.get("rank") == "#E8":
        symbol = "USDC"
        collateral = "eXAUt-1"
    elif kind == "reusd" and raw.get("rank") == "#E9":
        symbol = "USDT"
        collateral = "eUSDC-22"
    elif kind == "reusd" and raw.get("rank") == "#E10":
        symbol = "RLUSD"
        collateral = "eUSDC-70"
    elif kind == "reusd" and raw.get("rank") in ARB_SINGLES:
        symbol = "USDG"
        collateral = "syrupUSDG"
    result.update(gross_token_amount=_amount(q.get(gross), signed=True), gross_token_symbol=symbol,
                  repay_amount=_amount(q.get(repay)), repay_symbol=symbol, seize_amount=_amount(q.get(seize)), seize_symbol=collateral)
    # Only WETH quotes carry a separately supplied USD valuation. Stablecoins
    # are token amounts, not measured dollars; in particular M1's USD alias is DAI.
    if kind in {"weth", "wsteth"}:
        result["gross_usd"] = _amount(q.get("grossSurplusUsd"), signed=True)
    result["available"] = bool(measured and raw.get("rank") != "#M32" and result["gross_token_amount"] is not None and
                               all((_number(q.get(k)) or 0) > 0 for k in (repay, seize, output)))
    result["notes"] = ["Conditional gross quote before gas and other costs; not conservative net or realized profit.",
                       "Only explicit measured provenance at a fresh matching pin is a current quote."]
    if raw.get("rank") == "#M32":
        result["notes"] = ["Deployed-executor rehearsal reference, not a fresh executable quote.",
                           "Modeled net and original local-fork provenance are shown in Historical reference."]
    if kind not in {"weth", "wsteth"}:
        result["notes"].append(f"{symbol} amounts are not converted to USD.")
    if not result["available"]:
        if result["gross_token_amount"] is not None or result["gross_usd"] is not None:
            result["estimate"] = {**{k: result[k] for k in ("gross_token_amount", "gross_token_symbol", "gross_usd", "block", "hash", "utc", "source")},
                                  "provenance": basis, "label": "Stored estimate · not a current quote"}
        elif _amount(q.get("estimatedProfitUsd"), signed=True) is not None:
            result["estimate"] = {"gross_usd": _amount(q["estimatedProfitUsd"], signed=True),
                                  "gross_token_amount": None, "gross_token_symbol": None,
                                  "provenance": basis, "label": "Model estimate · not a current quote"}
        result["gross_token_amount"] = result["gross_usd"] = None
        result["notes"].append("Current quote unavailable: provenance, completeness or freshness is not established.")
    return result


def _arb_usdg_quote(raw: dict, obs: dict) -> dict:
    quote = _quote(raw, obs, "reusd")
    if raw.get("rank") not in ARB_SINGLES or quote["available"]:
        return quote
    # Historical simulations have no current quote pin and never establish readiness.
    gross = {"#ARB8": "688.92", "#ARB9": "8327.39"}[raw["rank"]]
    quote.update(estimate={"gross_token_amount": gross, "gross_token_symbol": "USDG", "gross_usd": None,
                           "provenance": "HISTORICAL", "label": "Historical simulation · not a current quote"}, is_simulated=True, freshness=UNKNOWN,
                 age_text=None, block=None, hash=None, utc=None, source=None,
                 notes=["Previously simulated gross surplus; not a current live quote, conservative net or realized profit.",
                        "Simulation uses a 250k tranche." if raw["rank"] == "#ARB9" else "Simulation size is not supplied by the current watch.",
                        "USDG amounts are not converted to USD."])
    return quote


def _m32_reference_valid(data: Any) -> bool:
    """Validate only the fixed report's public historical presentation fields."""
    if not isinstance(data, dict) or data.get("schema") != "m32-deployed-local-host/v1":
        return False
    rehearsal = data.get("rehearsal")
    pin = data.get("pin")
    if not isinstance(rehearsal, dict) or not isinstance(pin, dict):
        return False
    selected = rehearsal.get("selected")
    if not isinstance(selected, dict):
        return False
    net, replay = selected.get("net"), selected.get("replay")
    if not isinstance(net, dict) or not isinstance(replay, dict):
        return False

    def uint(value):
        return (isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,77})", value) is not None
                and int(value) < 2**256)

    started, completed = ops._iso(data.get("startedAt")), ops._iso(data.get("completedAt"))
    return (data.get("status") == rehearsal.get("status") == "LOCAL_REHEARSAL_PASS"
            and rehearsal.get("schema") == "m32-deployed-local-rehearsal/v1"
            and all(part.get(key) is False for part in (data, rehearsal)
                    for key in ("liveActions", "signing", "authorityConsumed", "productionTimingProven"))
            and rehearsal.get("localFixture") is True
            and all(rehearsal.get(key) is False for key in ("fullyArmed", "productionFullRunnerProven", "freshProductionQualificationProven"))
            and _address(rehearsal.get("executor")) == M32_EXECUTOR
            and _hash(rehearsal.get("runtimeKeccak256")) == M32_RUNTIME_KECCAK256
            and rehearsal.get("valuationBasis") == M32_VALUATION
            and rehearsal.get("syntheticAdvancementSeconds") == "43200"
            and type(pin.get("chainId")) is int and pin["chainId"] == 1
            and uint(pin.get("number")) and 0 < int(pin["number"]) <= 10**12
            and _hash(pin.get("hash")) is not None
            and uint(pin.get("timestamp")) and 0 < int(pin["timestamp"]) <= 9_999_999_999
            and isinstance(rehearsal.get("valuationPin"), dict)
            and all(rehearsal["valuationPin"].get(key) == pin[key] for key in ("number", "hash", "timestamp"))
            and started is not None and completed is not None and timestamp(started) <= timestamp(completed)
            and uint(net.get("usd8DecFloor")) and uint(net.get("nativeWei"))
            and replay.get("status") == "LOCAL_SETTLED" and replay.get("net") == net)


def _m32_historical_overlay(view: dict, reader: Any) -> dict:
    rows = [row for row in view["targets"] if row.get("id") == SINGLES["targetM32_Morpho_sUSDe_USDtb"]]
    if not rows:
        return view
    try:
        read = reader.read_json(M32_REFERENCE, validator=_m32_reference_valid)
    except KeyError:
        # The aggregate's restricted snapshot excludes this reference. The real
        # reader attaches it after resolution/sorting, never as current evidence.
        return view
    reference = {"available": False, "source": M32_REFERENCE, "source_artifact": ALLOWLIST[M32_REFERENCE],
                 "note": "Historical reference unavailable; the fixed report is missing or invalid."}
    if read.current and _m32_reference_valid(read.value):
        data = read.value
        rehearsal, pin = data["rehearsal"], data["pin"]
        net = rehearsal["selected"]["net"]
        usd = int(net["usd8DecFloor"])
        net_usd = f"{usd // 10**8}.{usd % 10**8:08d}"
        reference.update(available=True, label="Modeled net · historical local fork",
                         modeled_net_usd=net_usd, modeled_net_usd_display=f"{Decimal(net_usd):.2f}",
                         modeled_net_native_wei=net["nativeWei"],
                         started_at=ops._iso(data["startedAt"]), completed_at=ops._iso(data["completedAt"]),
                         original_block=int(pin["number"]), original_hash=_hash(pin["hash"]),
                         original_utc=ops._iso(int(pin["timestamp"])),
                         fixture_advance_seconds=int(rehearsal["syntheticAdvancementSeconds"]),
                         valuation_basis=rehearsal["valuationBasis"],
                         note="Original historical feed values with a +12h local interest fixture. Not current profit, realized profit, or production readiness.")
    for row in rows:
        row["historical_reference"] = reference
    return view


def _base_watch(value: Any) -> dict:
    """Admit only the fixed Base producer's bounded, unambiguous plan scope."""
    if (not ops.base_morpho_live_watch_valid(value) or type(value.get("chainId")) is not int
            or _address(value.get("deployedExecutor")) != BASE_EXECUTOR
            or any(key in value and _address(value[key]) != BASE_EXECUTOR for key in ("executor", "liquidatorAddress"))):
        return {}
    items = value.get("targets")
    if not isinstance(items, list) or not 0 < len(items) <= len(BASE_RUNNER_BINDINGS):
        return {}
    clean = _clean({key: item for key, item in value.items() if key != "targets"})
    pin = clean.get("pin") or {}
    seconds = pin.get("timestamp")
    if (pin.get("chainId") != 8453 or not pin.get("number") or not pin.get("hash")
            or seconds is None or ("utc" in pin and timestamp(pin["utc"]) != seconds)
            or ("blockNumber" in clean and clean["blockNumber"] != pin["number"])):
        return {}
    clean["pin"] = {**pin, "utc": ops._iso(seconds)}
    clean["targets"] = []
    seen_ids, seen_ranks, seen_borrowers = set(), set(), set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return {}
        ident = item["id"]
        binding = BASE_RUNNER_BINDINGS.get(ident)
        if binding is None:
            return {}
        rank, borrower, market, executor = binding
        venue = MORPHO if executor == BASE_EXECUTOR else market
        if (item.get("rank") != rank or _address(item.get("borrower")) != borrower
                or ident in seen_ids or rank in seen_ranks or borrower in seen_borrowers
                or ("chainId" in item and (type(item["chainId"]) is not int or item["chainId"] != 8453))
                or ("targetId" in item and item["targetId"] != ident)
                or ("marketId" in item and (_hash(item["marketId"]) or _address(item["marketId"])) != market)
                or any(key in item and _address(item[key]) != expected for key, expected in
                       (("user", borrower), ("executor", executor), ("deployedExecutor", executor), ("pool", venue)))
                or (executor != BASE_EXECUTOR and _address(item.get("executor")) != executor)):
            return {}
        seen_ids.add(ident)
        seen_ranks.add(rank)
        seen_borrowers.add(borrower)
        clean["targets"].append({"id": ident, "rank": rank, "borrower": borrower, "marketId": market, "executor": executor})
    return clean


def _base_monitor_config(value: Any, clean: dict) -> None:
    """Literal null in the fixed B1/B2 health monitor is not a contrary executor."""
    targets = value.get("targets") if isinstance(value, dict) else None
    if not isinstance(targets, dict) or not isinstance(targets.get("base_Morpho_Whales"), list):
        return
    for original, row in zip(targets["base_Morpho_Whales"], clean["targets"]["base_Morpho_Whales"]):
        if (not isinstance(original, dict) or original.get("observationKind") != "READ_ONLY_MONITOR"
                or original.get("observationOnly") is not True or row.get("chainId") != 8453
                or not any(row.get("rank") == rank and row.get("user") == borrower and row.get("marketId") == market
                           for rank, borrower, market, _ in BASE_RUNNER_BINDINGS.values() if rank in {"#B1", "#B2"})):
            continue
        for key in ("executor", "deployedExecutor"):
            # Inspect the original value: malformed addresses also clean to None
            # but must remain present so the strict report join rejects them.
            if key in original and original[key] is None:
                row.pop(key, None)


def _base_runner_match(watch: dict, row: dict, raw: dict, venue: str | None) -> dict | None:
    """Join report metadata only to an already-present full Base position."""
    for item in watch.get("targets", []):
        if row.get("rank") != item["rank"]:
            continue
        expected_venue = MORPHO if item["executor"] == BASE_EXECUTOR else item["marketId"]
        expected = {"rank": item["rank"], "chainId": 8453, "borrower": item["borrower"],
                    "executor": item["executor"], "deployedExecutor": item["executor"], "pool": expected_venue}
        if (row.get("chain_id") == 8453 and venue == expected_venue
                and raw.get("user") == item["borrower"] and raw.get("marketId") == item["marketId"]
                and all(key not in raw or raw[key] == value for key, value in expected.items())
                and ("id" not in raw or raw["id"] in (item["id"], row["id"]))):
            return item
    return None


def _runner_pin(pin: Any, source: str) -> dict:
    """Normalize only the fixed Ethereum producers, without overriding conflicts."""
    if source not in {V3_WATCH, V3_2K_2L_WATCH, V4_WATCH} or not isinstance(pin, dict):
        return {}
    if "chainId" in pin and pin["chainId"] != 1:
        return {}
    seconds = pin.get("timestamp")
    if not ops._bounded_int(seconds, 9_999_999_999) or seconds <= 0:
        return {}
    utc = ops._iso(seconds)
    if utc is None or ("utc" in pin and timestamp(pin["utc"]) != seconds):
        return {}
    return {**pin, "chainId": 1, "utc": utc}


def _current_2k_scope(watch: dict, ident: str, raw: dict) -> bool:
    """Bind the exclusive compact report, without inventing absent venue fields."""
    target_id = SINGLES[CURRENT_2K_TARGET]
    rank, borrower = V3_WHALE_BINDINGS[target_id]
    items = watch.get("targets")
    if (ident != target_id or watch.get("partition") != CURRENT_2K_SCOPE
            or watch.get("collectionScope") != CURRENT_2K_SCOPE
            or raw.get("rank") != rank or not isinstance(items, list) or len(items) != 1):
        return False
    item = items[0]
    if item.get("rank") != rank or item.get("user") != borrower:
        return False
    expected = {"id": target_id, "targetId": CURRENT_2K_TARGET, "rank": rank,
                "user": borrower, "borrower": borrower, "pool": POOL, "marketId": POOL,
                "chainId": 1, "executor": UNIFIED_EXECUTOR,
                "deployedExecutor": UNIFIED_EXECUTOR, "liquidatorAddress": UNIFIED_EXECUTOR}
    # Optional explicit identity fields may not contradict the fixed binding;
    # malformed values survive sanitization as None and therefore fail closed.
    return all(key not in part or part[key] == value
               for part in (watch, item, raw) for key, value in expected.items())


def _current_2k_2l_scope(watch: dict, ident: str, raw: dict) -> bool:
    """Require the complete two-row scope, including all optional identity claims."""
    items = watch.get("targets")
    if (watch.get("partition") != CURRENT_2K_2L_SCOPE or watch.get("collectionScope") != CURRENT_2K_2L_SCOPE
            or watch.get("liquidatorAddress") != UNIFIED_EXECUTOR
            or not isinstance(items, list) or len(items) != 2
            or ident not in {SINGLES[key] for key in CURRENT_2K_2L_TARGETS}):
        return False
    common = {"pool": POOL, "marketId": POOL, "chainId": 1, "executor": UNIFIED_EXECUTOR,
              "deployedExecutor": UNIFIED_EXECUTOR, "liquidatorAddress": UNIFIED_EXECUTOR}
    if (any(key in watch for key in ("id", "targetId", "rank", "user", "borrower"))
            or any(key in watch and watch[key] != value for key, value in common.items())):
        return False
    for target in CURRENT_2K_2L_TARGETS:
        target_id = SINGLES[target]
        rank, borrower = V3_WHALE_BINDINGS[target_id]
        matches = [item for item in items if item.get("rank") == rank and item.get("user") == borrower]
        if len(matches) != 1:
            return False
        expected = {**common, "id": target_id, "targetId": target, "rank": rank,
                    "user": borrower, "borrower": borrower}
        parts = (matches[0], raw) if ident == target_id else (matches[0],)
        if any(key in part and part[key] != value for part in parts for key, value in expected.items()):
            return False
    return True


def _current_2k_2l_valid(value: Any) -> bool:
    if (not ops.top_whale_executor_watch_valid(value) or type(value.get("armed")) is not bool
            or value.get("mode") not in ENUMS["mode"]):
        return False
    return _current_2k_2l_scope(_clean(value), SINGLES[CURRENT_2K_TARGET], {})


def _runner(raw: dict, normalized: dict, label: str | None, scoped: bool, obs: dict) -> dict:
    # Sentinel health/configuration is never an actual runner report.
    if obs.get("source") not in {V3_WATCH, V3_2K_2L_WATCH, V4_WATCH, ARB_WATCH, BASE_WATCH}:
        raw, normalized, scoped = {}, {}, False
        obs = {"freshness": UNKNOWN, "age_text": None}
    reported = raw.get("armed") if scoped and raw.get("ok") is True and obs["freshness"] == FRESH and raw.get("mode") in {"EXECUTE_IF_LIQUIDATABLE", "CHECK_ONLY", "WATCH"} and isinstance(raw.get("armed"), bool) else None
    if reported is True and raw.get("mode") != "EXECUTE_IF_LIQUIDATABLE":
        reported = None
    reason_code = reason_text = None
    shared = obs.get("source") in {V3_WATCH, V3_2K_2L_WATCH}
    # The fixed producer can fail before acquiring scope/pin. Explain its failure,
    # but never treat this source-level diagnostic as a borrower-scoped report.
    pre_scope_failure = (shared and raw.get("ok") is False and raw.get("mode") == "BLOCKED"
                         and not any(key in raw for key in ("partition", "liquidatorAddress", "morphoExecution", "pin")))
    if label and (scoped or pre_scope_failure) and raw.get("mode") == "BLOCKED":
        reason = raw.get("reason")
        reason_code = reason if shared and isinstance(reason, str) and reason in RUNNER_REASONS else None
        reason_text = RUNNER_REASONS[reason_code] if reason_code else (
            "Shared runner blocked; no supported reason is available." if shared else "Runner blocked; no supported reason is available.")
    notes = ["Reported telemetry only; not authorization, guaranteed firing or source/runtime equivalence."] if label else ["Observation only; no execution runner is assigned."]
    if reason_text:
        notes.append(reason_text)
        if pre_scope_failure:
            notes.append("Shared runner failure occurred before runner scope and pin were established; no borrower-specific runner state is inferred.")
    attributed = scoped or pre_scope_failure
    mode = normalized.get("mode")
    mode = mode if isinstance(mode, str) and mode in ENUMS["mode"] else None
    return {"label": label, "mode": mode if label and attributed else None,
            "source": obs.get("source") if scoped and raw.get("ok") is True else None,
            "freshness": obs["freshness"] if label and attributed else UNKNOWN, "age_text": obs["age_text"] if label and attributed else None,
            "checked_at": ops._iso(normalized.get("checked_at")) if label and attributed else None, "reported_armed": reported,
             "reason_code": reason_code, "reason_text": reason_text, "notes": notes}


def _rank1_v2_valid(data: Any) -> bool:
    """Accept only the dedicated producer's fixed identity and typed status facts."""
    if (not isinstance(data, dict) or data.get("targetId") != RANK1_TARGET
            or data.get("collectionScope") != "RANK1_ONLY"
            or any(_address(data.get(key)) != expected for key, expected in RANK1_BINDING.items())
            or data.get("mode") not in ("CHECK_ONLY", "STANDBY", "HOLD", "ATTEMPTED")):
        return False
    at = data.get("checkedAt")
    if (not isinstance(at, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", at) is None
            or ops._iso(at) is None):
        return False
    if (any(type(data.get(key)) is not bool for key in ("scheduled", "terminal", "executionReady"))
            or data["scheduled"] and data["terminal"]
            or any(key in data and type(data[key]) is not bool for key in ("ok", "armed"))
            or data.get("armed") is True):
        return False
    items = data.get("targets")
    if not isinstance(items, list) or len(items) > 1:
        return False
    if "pin" in data:
        pin = data["pin"]
        if (not isinstance(pin, dict) or not ops._bounded_int(pin.get("number"), 10**12) or pin["number"] == 0
                or _hash(pin.get("hash")) is None
                or "chainId" in pin and (type(pin["chainId"]) is not int or pin["chainId"] != 1)
                or not _runner_pin(_clean(pin), V4_WATCH)):
            return False
    for item in items:
        if (not isinstance(item, dict) or item.get("id") != "spokeA-candidate1-usde-usdc"
                or any(_address(item.get(key)) != RANK1_BINDING[key] for key in ("borrower", "spoke"))
                or item.get("mode") not in ("CURRENT", "NEXT_BLOCK_PASSIVE")
                or any(type(item.get(key)) is not bool for key in ("liquidatable", "isLiquidatableBothProviders"))
                or not isinstance(item.get("healthFactorRaw"), str)
                or re.fullmatch(r"(?:0|[1-9][0-9]{0,77})", item["healthFactorRaw"]) is None
                or int(item["healthFactorRaw"]) >= 2**256
                or _amount(item.get("bpsToLiquidation"), signed=True) is None):
            return False
    if data["mode"] != "HOLD" and (not items or "pin" not in data):
        return False
    if data["executionReady"] and (data["mode"] != "ATTEMPTED" or data.get("ok") is not True or not items
            or items[0]["liquidatable"] is not True or items[0]["isLiquidatableBothProviders"] is not True
            or int(items[0]["healthFactorRaw"]) >= 10**18):
        return False
    return True


def _runner_liveness(runner: dict, now: float | None = None, snapshot: Any = None) -> dict:
    result = {"state": UNKNOWN, "observed_at": None, "source": None,
              "note": "No exact target-runner process observation is available. A report is not proof of a running executor."}
    # Only this fixed job has no sentinel alias. Even its running script does not
    # prove this target's active scope; a complete negative inspection can prove absence.
    if runner.get("source") != V4_WATCH or not isinstance(snapshot, dict) or now is None:
        return result
    at = ops._iso(snapshot.get("observedAt"))
    age = now - timestamp(at) if at else None
    if (snapshot.get("schema") != "audit-jobs/v1" or snapshot.get("freshness") != FRESH
            or not isinstance(snapshot.get("inspection"), dict) or snapshot["inspection"].get("processes") != "OK"
            or age is None or not -5 <= age <= 45):
        return result
    jobs = snapshot.get("jobs")
    if not isinstance(jobs, list) or len(jobs) > 100:
        return result
    matches = [item for item in jobs if isinstance(item, dict) and item.get("id") == "aave-v4-executor-watch"]
    if len(matches) != 1:
        return result
    process = matches[0].get("process")
    if isinstance(process, dict) and process.get("state") == "NOT_RUNNING" and process.get("pids") == []:
        result.update(state="STOPPED", observed_at=at, source="aave-v4-executor-watch",
                      note="The exact runner script was not running at the process observation time.")
    return result


def _execution_evidence(row: dict, now: float | None = None, snapshot: Any = None) -> None:
    """Keep configuration, reported state and observed liveness independent."""
    original = row.get("sentinel_observation")
    if isinstance(original, dict) and (row.get("observation") or {}).get("source") == SENTINEL:
        # The aggregate resolver must not re-pin an incomplete cached row to the
        # successful document's head. Preserve independent non-sentinel evidence.
        if original.get("freshness") == UNKNOWN:
            row["observation"] = dict(original)
            row.update(observation_block=original.get("block"), observation_utc=original.get("utc"),
                       liquidatable_now=None, gross_usd_numeric=None)
            for item in row.get("provenance", []):
                if item.get("source") == SENTINEL:
                    item.update(original)
    runner = row.setdefault("runner", _runner({}, {}, None, False, {}))
    row["liveness"] = _runner_liveness(runner, now, snapshot)
    held = runner.get("held") is True and runner.get("freshness") == FRESH
    closed = row.get("position_status") == "CLOSED"
    row["armed"] = False if closed or held or row.get("observation_only") or row["liveness"]["state"] == "STOPPED" else None
    row["executable_now"] = False
    row["operational_state"] = row["liveness"]["state"]
    row["implementation"] = {"executor_address": row.get("executor_address") or _address(row.get("executor")),
                             "calldata_encoded": row.get("calldata_ready") is True,
                             "note": "Configured implementation only; not execution authority or readiness."}
    if not closed and not held and not row.get("observation_only"):
        row["readiness_note"] = M32_READINESS_NOTE if row.get("rank") == "#M32" else "Configured implementation only; runner liveness and execution authority are unknown."
    elif row.get("observation_only") and re.search(r"\barmed\b|execute[ _]if", row.get("readiness_note") or "", re.I):
        row["readiness_note"] = "Observation only; no execution readiness inferred."


def _home_evidence(view: dict, state: dict, reader: Any, now: float) -> dict:
    """Conservative final projection for the older home-page adapter."""
    tmap = state.get("targets") if isinstance(state.get("targets"), dict) else {}
    raw_rows = {ident: _clean(tmap.get(key)) for key, ident in SINGLES.items()}
    for key, (limit, prefix) in ARRAYS.items():
        items = tmap.get(key)
        if isinstance(items, list):
            raw_rows.update({f"{prefix}-{i}": _clean(item) for i, item in enumerate(items[:limit])})
    for row in view["targets"]:
        raw = raw_rows.get(row["id"], {})
        closed = row.get("position_status") == "CLOSED"
        chain = row.get("chain_id", 1)
        capture = _clean(state.get("baseObservation")) if chain == 8453 else {}
        pin = capture.get("pin", {}) if chain == 8453 else _clean(state.get("pin")) if chain == 1 else {}
        obs = _row_observation(raw, pin, state.get("generatedAt"), now, chain, SENTINEL,
                               state.get("ok") is not False and (chain != 8453 or capture.get("status") == "COMPLETE"))
        q = raw.get("liveQuote") or {}
        if row.get("rank") == "#M32" and (_address(raw.get("deployedExecutor") or raw.get("executor")) != M32_EXECUTOR
                or any(raw.get(key) for key in ("readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata"))):
            raw, q = {**raw, "liveQuote": None}, {}
        kind = ("observation" if row.get("observation_only") else "wsteth" if "seizedWstEth" in q else
                "weth" if "repayWeth" in q else "dai" if "repayDai" in q else "reusd" if "seizedReusd" in q else
                "usdc" if "repayUsdc" in q else "mseth")
        quote = _quote({**raw, "rank": row["rank"], "chainId": chain} if not closed else {}, obs, kind)
        metadata = _ARB_METADATA.get(row["id"])
        if metadata and metadata[8] is not None:
            quote["estimate"] = {"gross_token_amount": _amount(metadata[8]), "gross_token_symbol": metadata[4],
                                 "gross_usd": None, "provenance": "HISTORICAL_REFERENCE",
                                 "label": "Historical simulation · not a current quote"}
        # Old adapters sometimes used historical USD net as gross surplus. Never
        # carry that display value into the current quote field.
        row.update(quote=quote, observation=obs, gross_usd_numeric=_number(quote["gross_usd"], signed=True),
                   surplus_usd=(f"{quote['gross_token_amount']} {quote['gross_token_symbol']} (gross, pre-gas)" if quote["available"] else None))
        if obs["freshness"] != FRESH and not closed and chain != 42161:
            row["liquidatable_now"] = None
        if "max_liq_profit_usd" in row:
            row["max_liq_profit_usd"] = None
        _execution_evidence(row)
    return _m32_historical_overlay(view, reader)


def _rank1_v2_overlay(view: dict, reader: Any, now: float) -> dict:
    """Runner-only enrichment; neither child forecasts nor status pins are health."""
    try:
        read = reader.read_json(RANK1_V2_WATCH, validator=_rank1_v2_valid)
    except KeyError:
        # The aggregate's restricted legacy snapshot excludes this isolated file.
        # build_targets/build_inventory apply it once, through the real reader,
        # after legacy runner resolution so old armed telemetry cannot win.
        return view
    data = read.value if read.current and _rank1_v2_valid(read.value) else None
    for row in view["targets"]:
        if (row.get("id") != RANK1_ID or row.get("chain_id") != 1
                or row.get("borrower_address") != RANK1_BINDING["borrower"]
                or row.get("venue_address") != RANK1_BINDING["spoke"]):
            continue
        # Preserve unrelated legacy deployments. The fixed production executor
        # must not fall back to its old armed report when v2 is missing/invalid.
        if not (read.source or read.cached or row.get("executor_address") == RANK1_BINDING["deployedExecutor"]):
            continue
        at = ops._iso(data["checkedAt"]) if data else None
        fresh, age = ops._freshness_view(at, now)
        current = data is not None and fresh == FRESH
        mode = data["mode"] if data else None
        scheduled = data["scheduled"] if current else None
        terminal = data["terminal"] if current else None
        ready = bool(current and not terminal and data["executionReady"])
        if not current:
            reason = "Stored status is stale; current runner state is unknown" if fresh in {AGING, STALE} else "Runner status unavailable"
        elif mode == "CHECK_ONLY":
            reason = "Stopped; check only" if terminal else "Check only; monitoring" if scheduled else "Check only"
        else:
            state = "Stopped" if terminal else "Monitoring" if scheduled else "Not scheduled"
            detail = "execution attempt reported; success not established" if mode == "ATTEMPTED" else "on hold; no execution proof yet" if mode == "HOLD" else "no execution proof yet"
            reason = f"{state}; {detail}"
        runner = _runner({}, {"mode": mode, "checked_at": at}, "Dedicated Aave V4 #1 v2", False,
                         {"source": RANK1_V2_WATCH, "freshness": fresh, "age_text": ops._age_text(age)})
        runner.update(source=RANK1_V2_WATCH, reported_armed=False if current else None,
                      mode=mode, checked_at=at, freshness=fresh, age_text=ops._age_text(age),
                      scheduled=scheduled, terminal=terminal, execution_ready=ready, reason_text=reason)
        runner["notes"].extend([reason, "Status freshness is the last check, not a health pin or proof of execution readiness."])
        previous_reason = (row.get("runner") or {}).get("reason_text")
        blockers = [note for note in row.get("blockers", []) if note != previous_reason]
        row.update(runner=runner, scheduled=scheduled, terminal=terminal, execution_ready=ready,
                   armed=False, executable_now=False, calldata_ready=False,
                   executor_address=RANK1_BINDING["deployedExecutor"], executor=ops._short_address(RANK1_BINDING["deployedExecutor"]),
                   readiness_note=reason, blockers=[reason, *blockers])
    return view


def _current_2k_2l_overlay(view: dict, reader: Any, now: float) -> dict:
    """Optional runner telemetry only; unusable new evidence leaves legacy unchanged."""
    try:
        read = reader.read_json(V3_2K_2L_WATCH, validator=_current_2k_2l_valid)
    except KeyError:
        # Like the dedicated #1 overlay, this is outside the aggregate's fixed
        # legacy source snapshot and is applied once through the real reader.
        return view
    if not read.current or not _current_2k_2l_valid(read.value):
        return view
    watch = _clean(read.value)
    pin = _runner_pin(watch.get("pin"), V3_2K_2L_WATCH)
    obs = _observation(pin, watch.get("checkedAt"), now, 1, V3_2K_2L_WATCH,
                       watch.get("ok") is True and ("blockNumber" not in watch or watch["blockNumber"] == pin.get("number")))
    if obs["freshness"] != FRESH:
        return view
    normalized = {"mode": watch["mode"], "checked_at": watch["checkedAt"]}
    view["runners"]["v3"] = {**normalized, "available": True, "partition": CURRENT_2K_2L_SCOPE,
                              "source": V3_2K_2L_WATCH, "source_artifact": ALLOWLIST[V3_2K_2L_WATCH],
                              "freshness": obs["freshness"], "age_text": obs["age_text"], "block_number": obs["block"],
                              "candidate_count": watch.get("candidateCount")}
    for row in view["targets"]:
        previous = row.get("runner") or {}
        if previous.get("source") == V3_WATCH:
            # One selected unified report, not two live scopes. Other dedicated
            # runners remain untouched; the frozen legacy report is not merged.
            row["runner"] = _runner({}, {}, previous.get("label"), False, {})
            row["source_ids"] = [key for key in row.get("source_ids", []) if key != V3_WATCH]
            row["provenance"] = [item for item in row.get("provenance", []) if item.get("source") != V3_WATCH]
            row["blockers"] = [note for note in row.get("blockers", []) if note != previous.get("reason_text")]
        ident = row.get("id")
        if ident not in {SINGLES[key] for key in CURRENT_2K_2L_TARGETS}:
            continue
        rank, borrower = V3_WHALE_BINDINGS[ident]
        if (row.get("chain_id") != 1 or row.get("protocol") != "Aave V3" or row.get("rank") != rank
                or row.get("borrower_address") != borrower or row.get("venue_address") != POOL
                or row.get("executor_address") != UNIFIED_EXECUTOR):
            continue
        row["runner"] = _runner(watch, normalized, f"Unified Aave V3 {rank[1:]}", True, obs)
        if row.get("position_status") == "CLOSED":
            row["runner"]["reported_armed"] = False
        row["source_ids"] = [*row.get("source_ids", []), V3_2K_2L_WATCH]
        row["provenance"] = [*row.get("provenance", []), {**obs, "generated_at": watch["checkedAt"]}]
    return view


def build_curated_targets(reader: Any, now: float) -> dict[str, Any]:
    reads = {}
    for key, validator in READS.items():
        read = reader.read_json(key, validator=validator)
        clean = _clean(read.value) if read.current else None
        if key == SENTINEL and clean is not None:
            _base_monitor_config(read.value, clean)
        if key == BASE_WATCH and read.current:
            clean = _base_watch(read.value)
        if key == ARB_WATCH and clean is not None and arb_morpho_watch_valid(read.value):
            clean["pin"] = _arb_morpho_pin(read.value.get("pin"))
            clean["targets"] = [row for item in read.value["targets"][:9] if (row := _arb_morpho_row(item)) is not None]
        if clean is not None and key in {V3_WATCH, V4_WATCH} and "pin" in clean:
            clean["pin"] = _runner_pin(clean.get("pin"), key)
        valid = clean is not None and validator(clean)
        reads[key] = replace(read, value=clean if valid else None, current=valid)
    state = reads[SENTINEL].value or {}
    tmap = state.get("targets") or {}
    v3 = reads[V3_WATCH].value or {}
    narrow_v3 = any(scope in (v3.get("partition"), v3.get("collectionScope")) for scope in (CURRENT_2K_SCOPE, CURRENT_2K_2L_SCOPE))
    broad_v3 = not narrow_v3 and v3.get("partition") in BROAD_UNIFIED_PARTITIONS
    v4 = reads[V4_WATCH].value or {}
    arb_watch = reads[ARB_WATCH].value or {}
    base_watch = reads[BASE_WATCH].value or {}
    base_runner_obs = _observation(base_watch.get("pin"), base_watch.get("checkedAt"), now, 8453, BASE_WATCH,
                                   base_watch.get("ok") is True)
    arb_rows = {(row.get("id") or f"arb-morpho-{row['rank'][1:].lower()}"): row
                for row in arb_watch.get("targets", [])}
    raw_rows = {ident: tmap[key] for key, ident in SINGLES.items() if isinstance(tmap.get(key), dict)}
    raw_rows.update(arb_rows)
    for key, (limit, prefix) in ARRAYS.items():
        raw_rows.update({f"{prefix}-{i}": item for i, item in enumerate(tmap.get(key, [])[:limit])})
    # Dedicated overlays require full borrower AND venue identity, never an ID alone.
    matches, row_identities, watch_identities = {}, {}, {}
    for ident, raw in raw_rows.items():
        if ident == SINGLES["target1_AaveV4_USDe_USDC"] or ident.startswith("spoke-c-"):
            identity = (_address(raw.get("user")), _address(raw.get("spoke")))
            if all(identity):
                row_identities.setdefault(identity, []).append(ident)
    for item in v4.get("targets", []):
        identity = (_address(item.get("borrower")), _address(item.get("spoke")))
        if all(identity):
            watch_identities.setdefault(identity, []).append(item)
    for identity, identifiers in row_identities.items():
        candidates = watch_identities.get(identity, [])
        if len(identifiers) == 1 and len(candidates) == 1:
            matches[identifiers[0]] = candidates[0]
    v4_read = replace(reads[V4_WATCH], value={**v4, "targets": list(matches.values())}) if v4 else reads[V4_WATCH]
    view = ops.build_top_whale_triggers(reads[SENTINEL], reads["aave_v4_v3_morpho_liquidator_deploy"], now, reader,
        SENTINEL, "aave_v4_v3_morpho_liquidator_deploy", v4_deploy_read=reads["aave_v4_flash_liquidator_deploy"],
        v4_watch_read=v4_read, v4_rehearsal_read=reads["aave_v4_multi_spoke_rehearsal"], v3_watch_read=reads[V3_WATCH],
        base_rehearsal_read=reads["base_morpho_usde_rehearsal"], base_watch_read=reads[BASE_WATCH])
    # The Arbitrum watch is independent of the Ethereum sentinel, including when
    # build_top_whale_triggers returns early because that sentinel is unavailable.
    for ident, raw in arb_rows.items():
        fluid = ident in {ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID}
        metadata = _ARB_METADATA[ident] if fluid else None
        view["targets"].append({
            "id": ident, "rank": raw["rank"], "pair": raw["pair"], "protocol": "Fluid" if fluid else "Morpho Blue",
            "label": "Arbitrum Fluid T2 USDai-USDC / USDT0 (0x5eb4…d06f)" if ident == ARB_FLUID_42_ID else "Arbitrum Fluid T2 USDai-USDT0 / USDT0 (0xd9a7…3669)" if ident == ARB_FLUID_54_ID else "Arbitrum Fluid T2 sUSDe-USDT / USDT0 (0x81a0…3cbb)" if fluid else f"Morpho Arbitrum {raw['pair']} ({ops._short_address(raw['user'])})",
            "chain_id": 42161, "user_short": ops._short_address(raw["user"]),
            "venue_short": ops._short_address(raw["marketId"] if fluid else ARB_MORPHO), "observation_only": False,
            "health_is_estimate": False, "armed": arb_watch.get("armed") is True,
            "executable_now": False, "calldata_ready": False,
            "readiness_note": metadata[9] if fluid else "Reported Arbitrum runner telemetry; current profitability and execution readiness are not established.",
            "heartbeat_hours_left": f"{raw['collateralUsd']} USD collateral value" if raw.get("collateralUsd") is not None else None,
            "passive_hours_left": f"{raw['debtUsd']} USD debt" if raw.get("debtUsd") is not None else None,
            "repay_summary": f"{metadata[7]:,.2f} {metadata[4]}" if fluid and metadata[7] is not None else None,
            "seized_summary": metadata[6] if fluid else None,
        })
    if arb_rows:
        view["available"] = True
    for section in ("deploy", "v4_executor", "v3_live_watch", "v4_live_watch", "base_live_watch", "v4_rehearsal", "base_rehearsal"):
        view[section] = {key: None if value == "None" else value for key, value in view[section].items()}
    view["base_live_watch"].update(freshness=base_runner_obs["freshness"], age_text=base_runner_obs["age_text"], block_number=base_runner_obs["block"])
    runner_observations = {}
    for source, raw, section in ((V3_WATCH, v3, "v3_live_watch"), (V4_WATCH, v4, "v4_live_watch")):
        pin = raw.get("pin") or {}
        obs = _observation(pin, raw.get("checkedAt"), now, 1, source,
                           raw.get("ok") is True and ("blockNumber" not in raw or raw["blockNumber"] == pin.get("number")))
        runner_observations[source] = obs
        view[section].update(freshness=obs["freshness"], age_text=obs["age_text"], block_number=obs["block"])
    sentinel_obs = _observation(state.get("pin"), state.get("generatedAt"), now, 1, SENTINEL, state.get("ok") is not False)
    watch_obs = runner_observations[V4_WATCH]
    rows = []
    for existing in view["targets"]:
        ident = existing["id"]
        if ident not in raw_rows:  # Do not add the legacy synthetic #1B duplicate.
            continue
        raw, row = raw_rows[ident], dict(existing)
        if ident in DEBT_STATUS_BINDINGS and isinstance(raw.get("armed"), bool):
            row["armed"] = raw["armed"]
        arb = ident in arb_rows
        arb_fluid = ident in {ARB_FLUID_ID, ARB_FLUID_54_ID, ARB_FLUID_42_ID}
        arb_usdg = arb and raw.get("rank") in ARB_SINGLES
        b0 = ident == SINGLES["targetB0_Base_USDe_USDC"]
        b11 = ident == SINGLES["targetB11_Fluid_sUSDai_USDC_Vault48"]
        b12 = ident == SINGLES["targetB12_EulerV2_wtSPYM_USDC_0x1791"]
        b13 = ident == SINGLES["targetB13_EulerV2_wtCOIN_USDC_0x1791"]
        b14 = ident == SINGLES["targetB14_Base_USDe_USDC_0x6efc"]
        b15 = ident == SINGLES["targetB15_Base_yoUSD_USDC_0x5c2a"]
        b_extra = ident.startswith("base-usde-extra-")
        b7 = b_extra and row["rank"] == "#B7"
        b10 = b_extra and row["rank"] == "#B10"
        b_usde = ident.startswith("base-morpho-") and raw.get("marketId") == ops.BASE_USDE_MARKET and row["rank"] in {"#B1", "#B2"}
        base, paxg, m1 = (ident.startswith("base-morpho-") or b0 or b_extra or b11 or b12 or b13 or b14 or b15), ident == SINGLES["target3_Morpho_PAXG_USDC"], ident == SINGLES["targetM1_Morpho_USDe_DAI"]
        m2 = ident in {
            SINGLES["targetM2_Morpho_reUSD_USDC"],
            SINGLES["targetM2B_Morpho_reUSD_USDC"],
            SINGLES["targetM2C_Morpho_reUSD_USDC"],
            SINGLES["targetM2D_Morpho_reUSD_USDC"],
            SINGLES["targetM10_Morpho_USDe_RLUSD"],
            SINGLES["targetM12_Morpho_PT_USD3_USDC"],
            SINGLES["targetM13_Morpho_PT_USD3_USDC"],
            SINGLES["targetM15_Morpho_yoUSD_Edge_USDC"],
            SINGLES["targetM16_Morpho_apyUSD_apxUSD"],
            SINGLES["targetM17_Morpho_eUSDe_USDe"],
            SINGLES["targetM18_Morpho_USD3_USDC"],
            SINGLES["targetM19_Morpho_USD3_USDC"],
            SINGLES["targetM20_Morpho_USD3_USDC"],
            SINGLES["targetM21_Morpho_PT_apyUSD_apxUSD"],
            SINGLES["targetM22_Morpho_PT_apyUSD_apxUSD"],
            SINGLES["targetM23_Morpho_PT_reUSD_USDC"],
            SINGLES["targetM24_Morpho_PT_reUSD_USDC"],
            SINGLES["targetM25_Morpho_USD3_USDC"],
            SINGLES["targetM26_Morpho_USD3_USDC"],
            SINGLES["targetM27_Morpho_PT_reUSD_USDC"],
            SINGLES["targetM28_Morpho_PT_reUSD_USDC"],
            SINGLES["targetM31_Morpho_syrupUSDC_USDC"],
            SINGLES["targetF1_Fluid_USDe_USDT_Vault93"],
            SINGLES["targetF2_Fluid_eBTC_cbBTC_Vault96"],
            SINGLES["targetF3_Fluid_ETH_osETH_Vault159"],
            SINGLES["targetF4_Fluid_PAXG_XAUt_Vault123"],
            SINGLES["targetF5_Fluid_WBTC_LBTC_Vault115"],
            SINGLES["targetF6_Fluid_syrupUSDC_USDC_Vault145"],
            SINGLES["targetM33_Morpho_PT_reUSD_USDT"],
            SINGLES["targetM34_Morpho_beraSTONE_WETH"],
            SINGLES["targetM35_Morpho_PT_USD3_USDC"],
            SINGLES["targetM36_Morpho_sUSDS_USDT"],
            SINGLES["targetM37_Morpho_PST_USDT"],
            SINGLES["targetM38_Morpho_sUSDS_USDT"],
            SINGLES["targetM39_Morpho_reUSD_USDC"],
            SINGLES["targetM42_Morpho_strUSD_USDC"],
            SINGLES["targetM43_Morpho_PRIME_PYUSD"],
            SINGLES["targetM44_Morpho_srUSD_USDC"],
            SINGLES["targetM45_Morpho_reUSDe_USDC"],
            SINGLES["targetM46_Morpho_apyUSD_apxUSD"],
            SINGLES["targetM47_Morpho_USDe_RLUSD"],
            SINGLES["targetM48_Morpho_reUSD_USDT"],
            SINGLES["targetM49_Morpho_sUSDe_USDT"],
            SINGLES["targetE7_EulerV2_RLUSD_USDe_0x1066"],
            SINGLES["targetE8_Euler_eUSDC2_eXAUt1"],
            SINGLES["targetE9_Euler_eUSDT9_eUSDC22"],
            SINGLES["targetE10_Euler_eRLUSD7_eUSDC70"],
        }
        m2b = ident == SINGLES["targetM2B_Morpho_reUSD_USDC"]
        m2c = ident == SINGLES["targetM2C_Morpho_reUSD_USDC"]
        m2d = ident == SINGLES["targetM2D_Morpho_reUSD_USDC"]
        m10 = ident == SINGLES["targetM10_Morpho_USDe_RLUSD"]
        m11 = ident in {SINGLES["targetM11_Morpho_weETH_WETH"], SINGLES["targetM30_Morpho_wstETH_WETH"], SINGLES["targetM40_Morpho_weETH_WETH"], SINGLES["targetM41_Morpho_wstETH_WETH"]}
        m12 = ident == SINGLES["targetM12_Morpho_PT_USD3_USDC"]
        m13 = ident == SINGLES["targetM13_Morpho_PT_USD3_USDC"]
        m14 = ident in {SINGLES["targetM14_Morpho_PT_USDat_USDC"], SINGLES["targetM29_Morpho_PT_srUSDe_USDC"]}
        m29 = ident == SINGLES["targetM29_Morpho_PT_srUSDe_USDC"]
        m15 = ident == SINGLES["targetM15_Morpho_yoUSD_Edge_USDC"]
        m16 = ident == SINGLES["targetM16_Morpho_apyUSD_apxUSD"]
        m17 = ident == SINGLES["targetM17_Morpho_eUSDe_USDe"]
        m18 = ident == SINGLES["targetM18_Morpho_USD3_USDC"]
        m19 = ident == SINGLES["targetM19_Morpho_USD3_USDC"]
        m20 = ident == SINGLES["targetM20_Morpho_USD3_USDC"]
        m21 = ident == SINGLES["targetM21_Morpho_PT_apyUSD_apxUSD"]
        m22 = ident == SINGLES["targetM22_Morpho_PT_apyUSD_apxUSD"]
        m23 = ident == SINGLES["targetM23_Morpho_PT_reUSD_USDC"]
        m24 = ident == SINGLES["targetM24_Morpho_PT_reUSD_USDC"]
        m25 = ident == SINGLES["targetM25_Morpho_USD3_USDC"]
        m26 = ident == SINGLES["targetM26_Morpho_USD3_USDC"]
        m27 = ident == SINGLES["targetM27_Morpho_PT_reUSD_USDC"]
        m28 = ident == SINGLES["targetM28_Morpho_PT_reUSD_USDC"]
        m31 = ident == SINGLES["targetM31_Morpho_syrupUSDC_USDC"]
        m32 = ident == SINGLES["targetM32_Morpho_sUSDe_USDtb"]
        f1 = ident == SINGLES["targetF1_Fluid_USDe_USDT_Vault93"]
        f2 = ident == SINGLES["targetF2_Fluid_eBTC_cbBTC_Vault96"]
        f3 = ident == SINGLES["targetF3_Fluid_ETH_osETH_Vault159"]
        f4 = ident == SINGLES["targetF4_Fluid_PAXG_XAUt_Vault123"]
        f5 = ident == SINGLES["targetF5_Fluid_WBTC_LBTC_Vault115"]
        f6 = ident == SINGLES["targetF6_Fluid_syrupUSDC_USDC_Vault145"]
        m33 = ident == SINGLES["targetM33_Morpho_PT_reUSD_USDT"]
        m34 = ident == SINGLES["targetM34_Morpho_beraSTONE_WETH"]
        m35 = ident == SINGLES["targetM35_Morpho_PT_USD3_USDC"]
        m36 = ident == SINGLES["targetM36_Morpho_sUSDS_USDT"]
        m37 = ident == SINGLES["targetM37_Morpho_PST_USDT"]
        m38 = ident == SINGLES["targetM38_Morpho_sUSDS_USDT"]
        m39 = ident == SINGLES["targetM39_Morpho_reUSD_USDC"]
        m40 = ident == SINGLES["targetM40_Morpho_weETH_WETH"]
        m41 = ident == SINGLES["targetM41_Morpho_wstETH_WETH"]
        m42 = ident == SINGLES["targetM42_Morpho_strUSD_USDC"]
        m43 = ident == SINGLES["targetM43_Morpho_PRIME_PYUSD"]
        m44 = ident == SINGLES["targetM44_Morpho_srUSD_USDC"]
        m45 = ident == SINGLES["targetM45_Morpho_reUSDe_USDC"]
        m46 = ident == SINGLES["targetM46_Morpho_apyUSD_apxUSD"]
        m47 = ident == SINGLES["targetM47_Morpho_USDe_RLUSD"]
        m48 = ident == SINGLES["targetM48_Morpho_reUSD_USDT"]
        m49 = ident == SINGLES["targetM49_Morpho_sUSDe_USDT"]
        m7 = ident == SINGLES["targetM7_Morpho_ynETHx_msETH_Canary"]
        m7b = ident == SINGLES["targetM7B_Morpho_ynETHx_msETH_0x9b13"]
        yn = ident == SINGLES["targetYnEthx_Curve_NavArb"]
        e1 = ident == SINGLES["targetE1_EulerV2_RLUSD_USDC_0xbf21"]
        e2 = ident == SINGLES["targetE2_EulerV2_USDC_syrupUSDC_0x9f09"]
        e2_armed = e2 and _address(raw.get("executor") or raw.get("deployedExecutor")) == UNIV4_FLASH_EXECUTOR
        e3 = ident == SINGLES["targetE3_EulerV2_WETH_ynETHx_0x831e"]
        e4 = ident == SINGLES["targetE4_EulerV2_WETH_ynETHx_0x8062"]
        e5 = ident == SINGLES["targetE5_EulerV2_USDC_USDT_0xd1ed"]
        e6 = ident == SINGLES["targetE6_EulerV2_USDT_USDC_0x079d"]
        e7 = ident == SINGLES["targetE7_EulerV2_RLUSD_USDe_0x1066"]
        e8 = ident == SINGLES["targetE8_Euler_eUSDC2_eXAUt1"]
        e9 = ident == SINGLES["targetE9_Euler_eUSDT9_eUSDC22"]
        e10 = ident == SINGLES["targetE10_Euler_eRLUSD7_eUSDC70"]
        euler_armed = e1 or e2_armed or e3 or e4 or e5 or e6
        euler = euler_armed or e2 or e7 or e8 or e9 or e10 or b12 or b13
        pt = ident in {SINGLES["targetM8_Morpho_PT_USDe_DAI"], SINGLES["targetM9_Morpho_PT_USDe_DAI"], SINGLES["targetM14_Morpho_PT_USDat_USDC"], SINGLES["targetM29_Morpho_PT_srUSDe_USDC"]}
        pt_armed = pt and _address(raw.get("executor") or raw.get("deployedExecutor")) == PENDLE_PT_EXECUTOR
        a3 = ident == SINGLES["targetA3_AaveV4_USDe_USDC_0x1d9c"]
        a4 = ident == SINGLES["targetA4_AaveV4_SameAsset_0xa429"]
        a5 = ident == SINGLES["targetA5_AaveV4_syrupUSDG_USDG_0x080c"]
        a6 = ident == SINGLES["targetA6_AaveV4_syrupUSDG_USDG_0xbd81"]
        a7 = ident == SINGLES["targetA7_AaveV4_syrupUSDG_USDG_0x28e8"]
        a8 = ident == SINGLES["targetA8_AaveV4_syrupUSDG_USDG_0x707e"]
        a9 = ident == SINGLES["targetA9_AaveV4_syrupUSDG_USDG_0x90ff"]
        a10 = ident == SINGLES["targetA10_AaveV4_syrupUSDG_USDG_0x6efc"]
        a11 = ident == SINGLES["targetA11_AaveV4_USDe_USDC_0x5c43"]
        a12 = ident == SINGLES["targetA12_AaveV4_WBTC_USDT_0xac90"]
        a13 = ident == SINGLES["targetA13_AaveV4_wstETH_WETH_0x4cd7"]
        a14 = ident == SINGLES["targetA14_AaveV4_syrupUSDG_USDG_0xabcc"]
        a15 = ident == SINGLES["targetA15_AaveV4_weETH_WETH_0x3519"]
        a16 = ident == SINGLES["targetA16_AaveV4_syrupUSDG_USDG_0x9cd7"]
        a17 = ident == SINGLES["targetA17_AaveV4_weETH_WETH_0xa751"]
        a18 = ident == SINGLES["targetA18_AaveV4_syrupUSDG_USDG_0xdd64"]
        c9 = ident == SINGLES["targetC9_AaveV4_weETH_WETH_0x9f46"]
        syrup_usdg = a5 or a6 or a7 or a8 or a9 or a10 or a12 or a14 or a16 or a18
        m_wst = ident.startswith("morpho-wsteth-") or m11
        v3_2j = ident == SINGLES["target2J_AaveV3_wstETH_WETH_0x037a"]
        v3_whale = V3_WHALE_BINDINGS.get(ident)
        spark_whale = SPARK_WHALE_BINDINGS.get(ident)
        observation_only = (base and not (b0 or b_extra or b_usde or b11 or b12 or b13 or b14 or b15)) or paxg or a3 or (pt and not pt_armed) or (e2 and not e2_armed)
        if m32:
            is_m32_bound = (_address(raw.get("deployedExecutor") or raw.get("executor")) == M32_EXECUTOR
                            and not any(isinstance(raw.get(k), str) and raw[k].startswith("0x")
                                        for k in ("readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata")))
            m32_raw = raw if is_m32_bound else {**raw, "liveQuote": None}
            q = m32_raw.get("liveQuote") or {}
            row.update(observation_only=False, armed=None,
                       executable_now=False, calldata_ready=False,
                       executor_family="m32", executor_name=M32_CONTRACT_NAME,
                       expected_runtime_keccak256=M32_RUNTIME_KECCAK256,
                       readiness_note=M32_READINESS_NOTE,
                       repay_summary=f"{_amount(q.get('repayUsdc'))} USDtb" if _amount(q.get("repayUsdc")) is not None else None,
                       seized_summary=f"{_amount(q.get('seizedReusd'))} sUSDe" if _amount(q.get("seizedReusd")) is not None else None)
        elif yn:
            row.update(protocol_label="Curve/NAV", group_key="curve-nav",
                       observation_only=False, armed=None, executable_now=False)
        elif euler_armed:
            row.update(protocol_label="Euler V2", group_key="euler-v2",
                       observation_only=False, armed=None, executable_now=False)
        elif e2:
            row.update(protocol_label="Euler V2", group_key="euler-v2",
                       observation_only=True, armed=False, executable_now=False)
        kind = "wbtc-usdt" if a12 else "syrup-usdg" if syrup_usdg else "same-asset-usdc" if a4 else "yousd" if (b7 or b10) else "reusd" if (m2 or m32 or m14 or b11 or b12 or b13 or b14 or b15 or e7 or e8 or e9 or e10) else "mseth" if (m7 or m7b or yn or e1) else "usdc" if (ident == SINGLES["target1_AaveV4_USDe_USDC"] or a3 or a11 or b0 or b_extra or b_usde) else "wsteth" if (v3_2j or spark_whale or m_wst or a13) else "observation" if observation_only else "dai" if m1 else "weth"
        if arb:
            kind = "observation"  # The runner publishes health, not live profit quotes.
        obs = _row_observation(raw, state.get("pin") or {}, state.get("generatedAt"), now, 1, SENTINEL, state.get("ok") is not False)
        if m7 or m7b or e4:
            row["buffer_capacity"] = _buffer_capacity(raw, state.get("pin") or {}, state.get("generatedAt"), now, state.get("ok") is not False)
        health, eligible, bps = _number(raw.get("healthFactor")), raw.get("liquidatableNow"), _number(raw.get("bpsToLiquidation"), signed=True)
        if (m7 or m7b or yn or e3 or e4) and isinstance(raw.get("hfUnderwaterNow"), bool):
            eligible = raw["hfUnderwaterNow"]  # Protocol health is separate from buffer-gated execution.
        if base:
            capture = state.get("baseObservation") or {}
            pin = capture.get("pin") or {}
            obs = _row_observation(raw, pin, state.get("generatedAt"), now, 8453, SENTINEL, capture.get("status") == "COMPLETE" and state.get("ok") is not False)
        elif arb:
            pin = arb_watch.get("pin") or {}
            obs = _observation(pin, arb_watch.get("checkedAt"), now, 42161, ARB_WATCH,
                               arb_watch.get("ok") is True and ("blockNumber" not in arb_watch or arb_watch["blockNumber"] == pin.get("number")))
        quote_obs = dict(obs)
        matched = matches.get(ident)
        newer = matched and watch_obs["freshness"] == FRESH and watch_obs["block"] is not None and (sentinel_obs["block"] is None or watch_obs["block"] >= sentinel_obs["block"]) and timestamp(v4.get("checkedAt")) >= timestamp(state.get("generatedAt"))
        if newer:
            obs = dict(watch_obs)
            hf_raw = _amount(matched.get("healthFactorRaw"))
            health = float(Decimal(hf_raw) / Decimal(10**18)) if hf_raw is not None and "." not in hf_raw else None
            eligible, bps = matched.get("isLiquidatableBothProviders"), _number(matched.get("bpsToLiquidation"), signed=True)
        borrower = _address(raw.get("user")) if not paxg else None
        venue = _address(raw.get("marketId")) if yn or euler or b11 or f4 or f5 or f6 else MORPHO if base or paxg or m1 or m2 or m32 or m7 or m7b or m_wst or pt else _address(raw.get("spoke") or raw.get("pool"))
        if a12:
            venue = _address(raw.get("spoke")) or "0x973a023a77420ba610f06b3858ad991df6d85a08"
        elif a13:
            venue = _address(raw.get("spoke")) or "0xe1900480ac69f0b296841cd01cc37546d92f35cd"
        elif a14 or a16 or a18:
            venue = _address(raw.get("spoke") or raw.get("marketId")) or "0x774b9655413c34809c1f1b16b654465a89ebe989"
        elif a15 or a17:
            venue = _address(raw.get("spoke") or raw.get("marketId")) or "0xbf10bdfe177de0336afd7fccf80a904e15386219"
        elif v3_whale:
            venue = _address(raw.get("pool") or raw.get("marketId")) or POOL
        elif spark_whale:
            venue = _address(raw.get("pool") or raw.get("marketId")) or SPARK_POOL
        elif arb:
            venue = _address(raw.get("marketId")) if arb_fluid else ARB_MORPHO
        known = (health is not None and isinstance(eligible, bool) and eligible == (health < 1) and (borrower is not None or arb_fluid) and venue is not None
                 and raw.get("observationStatus") not in {"INCOMPLETE", "UNAVAILABLE"}
                 and (_address(raw.get("marketId")) is not None if f1 or f2 or f3 or f4 or f5 or f6 or b11 or b12 or b13 or e7 or e8 or e9 or e10 else not (m1 or m2 or m32 or m7 or m7b or m_wst or pt) or _hash(raw.get("marketId")) is not None))
        debt_status = _position_debt_status(ident, raw, (state.get("baseObservation") or {}).get("pin") or {} if base else state.get("pin") or {})
        closed = debt_status == "CLOSED" and obs["freshness"] != UNKNOWN and state.get("ok") is not False
        if closed:
            code, label, tone = ("INACTIVE", "Inactive / closed", "neutral") if obs["freshness"] == FRESH else ("STALE", "Stale observation", "warning")
            eligible = False
        elif not observation_only and (not known or obs["freshness"] == UNKNOWN):
            code, label, tone = "UNKNOWN", "Health unknown", "warning"
        elif observation_only:
            code, label, tone = "OBSERVATION_ONLY", "Observation only", "neutral"
        elif obs["freshness"] != FRESH:
            code, label, tone = "STALE", "Stale observation", "warning"
        elif eligible:
            code, label, tone = "ELIGIBLE", "Protocol eligible", "positive"
        else:
            code, label, tone = "WATCH", "Watching", "neutral"
        executor = None if observation_only else _address(raw.get("deployedExecutor")) if (m1 or m_wst or b0 or b_extra) else view["deploy"]["contract_address"]
        if m2 or m7 or m7b or yn or euler_armed or syrup_usdg or pt_armed or b_usde or b7 or b10:
            executor = M2_EXECUTOR if m2 else M7_EXECUTOR if (m7 or m7b) else YN_EXECUTOR if yn else PENDLE_PT_EXECUTOR if pt_armed else UNIV4_FLASH_EXECUTOR if (syrup_usdg or e2_armed) else EULER_EVK_EXECUTOR if euler_armed else BASE_EXECUTOR
        if m32:
            executor = M32_EXECUTOR
        if a14 or a16 or a18:
            executor = AAVE_V4_SPOKE_FLASH_EXECUTOR
        if f1 or f2 or f3 or f4 or f5 or f6 or m33 or m34 or m36 or m37 or m38 or m42 or m43 or m44 or m45 or m48 or m49:
            executor = UNIVERSAL_EXECUTOR
        if m40 or m41:
            executor = M1_EXECUTOR
        elif b14 or b15:
            executor = BASE_EXECUTOR
        if b11:
            executor = BASE_UNIVERSAL_EXECUTOR
        elif b12 or b13:
            executor = BASE_EULER_EVK_EXECUTOR
        elif e7 or e8 or e9 or e10:
            executor = ETH_UNIVERSAL_EULER_EXECUTOR
        if arb:
            executor = (_address(raw.get("executor")) or ARB_FLUID_EXECUTOR) if arb_fluid else ARB_UNIVERSAL_EXECUTOR if arb_usdg else ARB_EXECUTOR
            scoped = _address(raw.get("executor")) == ARB_FLUID_EXECUTOR if arb_fluid else _address(raw.get("executor")) == executor if arb_usdg else _address(arb_watch.get("deployedExecutor")) == executor
            runner = _runner(arb_watch, {"mode": arb_watch.get("mode"), "checked_at": arb_watch.get("checkedAt")},
                             "Arbitrum Fluid Runner" if arb_fluid else "Arbitrum Morpho Runner", scoped, obs)
        elif v3_whale or spark_whale:
            binding = spark_whale or v3_whale
            executor = UNIFIED_EXECUTOR
            scoped = (borrower == binding[1] and venue == (SPARK_POOL if spark_whale else POOL)
                      and (broad_v3 or _current_2k_scope(v3, ident, raw) or _current_2k_2l_scope(v3, ident, raw))
                      and _address(v3.get("liquidatorAddress")) == executor)
            runner = _runner(v3, view["v3_live_watch"], f"Unified {'SparkLend' if spark_whale else 'Aave V3'} {binding[0][1:]}", scoped, runner_observations[V3_WATCH])
        elif a11 or a13 or c9 or a15 or a17:
            executor = "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7" if a11 else "0xf09a01a6c23b936d5a51abce87a6ec8442a44262"
            expected_user = "0x5c430ff6f374da12218b380d2040299ae5b6d40e" if a11 else "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec" if a13 else "0x9f4625288fb381f74285ba84230403ce4b8a6c1d"
            if a15 or a17:
                expected_user = "0x3519ee4d387150f230baca90f5c50e9d296164c6" if a15 else "0xa7512e41d75b27f5a79b5f21aee1fee372fded5e"
            expected_spoke = "0xba1b3d55d249692b669a164024a838309b7508af" if a11 else "0xe1900480ac69f0b296841cd01cc37546d92f35cd" if a13 else "0xbf10bdfe177de0336afd7fccf80a904e15386219"
            scoped_aave = (borrower == expected_user and venue == expected_spoke
                           and _address(raw.get("deployedExecutor") or raw.get("executor")) == executor)
            telemetry = {"mode": None}  # Configuration is not a runner report.
            runner = _runner(telemetry, {"mode": telemetry["mode"], "checked_at": obs["utc"]}, "Unified Morpho A15" if a15 else "Unified Morpho A17" if a17 else "Dedicated Aave V4 A11" if a11 else "Unified Aave V4 A13" if a13 else "Unified Aave V4 C9", scoped_aave, obs)
        elif row["protocol"] == "Aave V4" and not (a3 or a4 or syrup_usdg):
            runner = _runner(v4, view["v4_live_watch"], "Dedicated Aave V4", bool(matched), watch_obs)
            if matched:
                executor = _address(v4.get("deployedExecutor"))
        elif a4:
            scoped_a4 = (borrower == "0xa4298746f662119a4df27fa57f20e18e44ccb767" and venue == "0x94e7a5dcbe816e498b89ab752661904e2f56c485"
                         and broad_v3 and _address(v3.get("liquidatorAddress")) == executor and executor is not None)
            runner = _runner(v3, view["v3_live_watch"], "Unified Aave V4 A4", scoped_a4, runner_observations[V3_WATCH])
        elif syrup_usdg:
            expected_user = "0xac90a9f2cf5636202919455f263746e5f98f937d" if a12 else "0x080ccea8654fd4ff80b81e46cff2278689d88fb0" if a5 else "0xbd810c549c287c759ff9044efeb1712bc1a58edd" if a6 else "0x28e81c2230bf90ed002aa4a0451acbae49559e2b" if a7 else "0x707ecbafef8dbc3b248b8a6fd6ca45e7c569a85c" if a8 else "0x90fff1dad57875e08df86df05bcebb3fd3514dfb" if a9 else "0x6efc48b8b6222924fa6ea95d174af5518b761177"
            if a14 or a16 or a18:
                expected_user = "0xabcc4b4227fc2bcf0fda9776bbe7ffce69e23d64" if a14 else "0x9cd74118eed35372672e66bb6af6e6454f94df05" if a16 else "0xdd647ce113505b34c62412d2a804ce1bfbcfc737"
            expected_spoke = "0x973a023a77420ba610f06b3858ad991df6d85a08" if a12 else "0x774b9655413c34809c1f1b16b654465a89ebe989"
            scoped_syrup = (borrower == expected_user and venue == expected_spoke
                         and _address(raw.get("deployedExecutor") or raw.get("executor")) == executor)
            telemetry = {"mode": None}  # Configuration is not a runner report.
            runner = _runner(telemetry, {"mode": telemetry["mode"], "checked_at": obs["utc"]}, "Unified Morpho A14" if a14 else "Unified Morpho A16" if a16 else "Unified Morpho A18" if a18 else "Unified Aave V4 A12" if a12 else "Unified Aave V4 A5" if a5 else "Unified Aave V4 A6" if a6 else "Unified Aave V4 A7" if a7 else "Unified Aave V4 A8" if a8 else "Unified Aave V4 A9" if a9 else "Unified Aave V4 A10", scoped_syrup, obs)
        elif pt_armed:
            expected_pt_user = "0x723cf98bfa71d786e3962140b79823637d0bbc0b" if m29 else "0x09c67aa4ee667872a9e8e2c0310b4a7fe8d3fc44" if m14 else "0x9b75df7f7cd5b74b8f0f0de8f4751c3f8e9695bb" if ident == SINGLES["targetM8_Morpho_PT_USDe_DAI"] else "0x64d85278a093ee5c57739c6c0de6c4eef53a1e02"
            expected_pt_market = "0x79b4e55cef9e7c214b5cc965e1984229ada26a66051e35366a75c4d92b776735" if m29 else "0x69ef7fd17b42cd7df6d885aee1b11380837afbc1664b25587041cf193b31617b" if m14 else ops.PT_USDE_DAI_MARKET
            scoped_pt = (borrower == expected_pt_user and raw.get("marketId") == expected_pt_market
                         and _address(raw.get("deployedExecutor") or raw.get("executor")) == executor)
            telemetry = {"mode": None}  # Configuration is not a runner report.
            runner = _runner(telemetry, {"mode": telemetry["mode"], "checked_at": obs["utc"]}, "Unified Morpho PT", scoped_pt, obs)
        elif m32:
            runner = _runner({}, {}, "Dedicated Morpho M32", False, {"freshness": UNKNOWN, "age_text": None})
            runner["notes"].append("Execution watcher status is unverified here; the sentinel observes health only.")
        elif observation_only:
            runner = _runner({}, {}, None, False, {})
        elif b0 or b_extra or b_usde:
            runner = _runner({}, {}, "Base Morpho Runner", False, {})
        elif m2 or m7 or m7b or yn or euler_armed or b11 or b12 or b13 or b14 or b15:
            expected_user = "0x8d54e7f07f5502dc6428644c72850790c5dbc198" if m10 else "0x92ee32937f3a86bb897e3b15de55078f18cb7cb2" if m12 else "0x2e598eb2703069ebaabec95adcf684bc12a3eafd" if m13 else "0xe9b7f44e18c1afe573c937c5124b55eeeaff95fe" if m15 else "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0" if m16 else "0x115ea1d4f996a6305d029102a9a159827278adbc" if m2b else "0x9d9dcf7d05593cbca6869ee10695da6c6c137f4a" if m2c else "0x822eb2e51965f3a8b0ee7463853d563a0dd63c40" if m2d else "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5" if m2 else "0xd65ed4bce447195187f37ce7d82f56adf1826f8f" if yn else "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772" if e1 else "0x9f09502a0b68edbccdff5e6c59270ad150def361" if e2_armed else "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82" if m7b else "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550"
            expected_market = "0xd9d2fc090bdbab1804ea960dd6669b62357787e5816f575f14ca4e6d999614bf" if m10 else "0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837" if m12 else "0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89" if m13 else "0x60bcabb1f18a4d9f83bb8f74121e70a0bbb7567a93e93ba846b18902460ff48c" if m15 else "0xe23380494e365453f72f736f2d941959ae945773eb67a06cf4f538c7c4201264" if m16 else "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed" if m2 else "0xd65ed4bce447195187f37ce7d82f56adf1826f8f" if yn else "0xe1ce9af672f8854845e5474400b6ddc7ae458a10" if e1 else "0x9bd52f2805c6af014132874124686e7b248c2cbb" if e2_armed else "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a"
            if m17 or m18 or m19 or m20:
                expected_user = "0x6adac55e197c09001a605e54042670f5adced052" if m17 else "0x599275be9753ecd8e6c380a7ef78e38711b8f212" if m18 else "0x0a907c7ce498b6a1d1dc42dad1acbd97d96392e8" if m19 else "0x2385233abb910357e2b97a16d40e0443e53d0769"
                expected_market = "0x140fe48783fe88d2a52b31705577d917628caaf74ff79865b39d4c2aa6c2fd3c" if m17 else "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7"
            elif m21 or m22:
                expected_user = "0x35316f7c2452958385e444bfc182f0192bee2dd4" if m21 else "0x687f584fd1f4a4d9eb277c03a24fe28f4b0675b7"
                expected_market = "0xebd23a871b52e0a8c92bd719f4413600101b69e946cb72923b3a33fb5bc6ec85"
            elif m23 or m24:
                expected_user = "0x64fbb84b9a101227af977ab5916cdead0de630bb" if m23 else "0x0794e8e138825ab2f5cf91c4a4bf235276416333"
                expected_market = "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64"
            elif m25 or m26:
                expected_user = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5" if m25 else "0xb47c72be8a2968dec42d3b9d8c6f464224605bfd"
                expected_market = "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7"
            elif m27 or m28:
                expected_user = "0xcc58accacd0db8010e4c8a20ba49d2dc9d4d7f59" if m27 else "0xf4766c366f15ab0f338ecc9bef49bbaac13649a6"
                expected_market = "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64"
            elif m31:
                expected_user = "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f"
                expected_market = "0x729badf297ee9f2f6b3f717b96fd355fc6ec00422284ce1968e76647b258cf44"
            elif f1:
                expected_user = "0x60753e8622a6cfea1df449a9625a9778bb922b72"
                expected_market = "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881"
            elif f2:
                expected_user = "0x3fb6784e263643656f386a0371644931133d7b78"
                expected_market = "0x43d1ca906c72f09d96291b4913d7255e241f428d"
            elif f3:
                expected_user = "0x2685c0e39eeaad383fb71ec3f493991d532a87ae"
                expected_market = "0x40d0aa5041d4c591d26a5ce59fb62629d0c23b8d"
            elif f4:
                expected_user = "0x0558284633e383f7dad328ce84c77a7b2fe4303b"
                expected_market = "0x78ec4dfb48f9dee98a1793854e94b5eaf4305516"
            elif f5:
                expected_user = "0xc0cff473726061e22b64b7680cd8c2e09cea5d86"
                expected_market = "0x57a9f4e109ecef8990bc794df0d159fb29861f2a"
            elif f6:
                expected_user = "0xa651887052a78dd9a279ad089ef8b7b979889fe4"
                expected_market = "0x01510793df6ad5c1a8ae592158713176cbd17a62"
            elif m33:
                expected_user = "0x0794e8e138825ab2f5cf91c4a4bf235276416333"
                expected_market = "0x6acd18854e43f93f5a90446004c35c72a68af1ad99f08cb247782ce6457914ca"
            elif m34:
                expected_user = "0x52426c8065974821e99fa3c9aad73e47b9f1d6fc"
                expected_market = "0xf78b7d3a62437f78097745a5e3117a50c56a02ec5f072cba8d988a129c6d4fb6"
            elif m35:
                expected_user = "0x0a12127877a785941fc79f0deabe354a79390f0f"
                expected_market = "0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837"
            elif m36:
                expected_user = "0x56f91d80cdf27b9e7abe845fa4bfec05f7de2794"
                expected_market = "0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b"
            elif m37:
                expected_user = "0x0794e8e138825ab2f5cf91c4a4bf235276416333"
                expected_market = "0x42f33c1873126e8eb6f935cfd1e4e9e79b383e037b1c493bc1a396394a097739"
            elif m38:
                expected_user = "0x8d54e7f07f5502dc6428644c72850790c5dbc198"
                expected_market = "0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b"
            elif m39:
                expected_user = "0x5d8604fcbda7ef027d79eab8300aa8c85d247c84"
                expected_market = "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed"
            elif m42:
                expected_user = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5"
                expected_market = "0x975c6e8b71073a82216ae464bc44f67d71988450d2542d635d88bc78fca344b1"
            elif m43:
                expected_user = "0x8d54e7f07f5502dc6428644c72850790c5dbc198"
                expected_market = "0x41c41d0c9aadbf4751f5ee215ed5a16954a4b34e1b70fca5393d4b08858fa3fa"
            elif m44:
                expected_user = "0x76f768dbeaa0264185b7a4952540656ad7b54148"
                expected_market = "0xbfed072faee09b963949defcdb91094465c34c6c62d798b906274ef3563c9cac"
            elif m45:
                expected_user = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5"
                expected_market = "0x904142eba80012455c361f3c442b9c89c0dd0fb86c7d8f062c4425bfa2314eb9"
            elif m46:
                expected_user = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5"
                expected_market = "0xe23380494e365453f72f736f2d941959ae945773eb67a06cf4f538c7c4201264"
            elif m47:
                expected_user = "0x6efc48b8b6222924fa6ea95d174af5518b761177"
                expected_market = "0xd9d2fc090bdbab1804ea960dd6669b62357787e5816f575f14ca4e6d999614bf"
            elif m48:
                expected_user = "0x1cb432f80416f07db4420b8c20447924a0658894"
                expected_market = "0x9105a5447f3eecdf768f04da12d580a878106e2e6b234312db2ee0f304539e35"
            elif m49:
                expected_user = "0x52ac2d6711c30c389433bada0ad8f8ebb1c3f6f7"
                expected_market = "0xdc5333039bcf15f1237133f74d5806675d83d9cf19cfd4cfdd9be674842651bf"
            elif b11:
                expected_user = "0x7e0371ec1177d3cf177a1a9a87dbc1e1864cd828"
                expected_market = "0x59fa2f51f5c8fffceb538180ec47a869ec3dbd4a"
            elif b12 or b13:
                expected_user = "0x17914d576bd7d14a14bdf187d1c72b194c61e35b" if b13 else "0x17914d576bd7d14a14bdf187d1c72b194c61e358"
                expected_market = "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e"
            elif b14 or b15:
                expected_user = "0x6efc48b8b6222924fa6ea95d174af5518b761177" if b14 else "0x5c2a8098c392fde0fa736e598ced595a9d6eb0b8"
                expected_market = ops.BASE_USDE_MARKET if b14 else ops.BASE_YOUSD_MARKET
            elif e7:
                expected_user = "0x1066e8f077dce3f9540426569a4653cb4f70cf12"
                expected_market = "0xe1ce9af672f8854845e5474400b6ddc7ae458a10"
            elif e8:
                expected_user = "0x3a8306fb4fa0811a86955f4421600e3b500a9e44"
                expected_market = "0x797dd80692c3b2dadabce8e30c07fde5307d48a9"
            elif e9:
                expected_user = "0x852839977253c27146168cb2df856bec78261a71"
                expected_market = "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8"
            elif e10:
                expected_user = "0x09e6691f61a2bc16725ea53ed1ac7e4e7517a468"
                expected_market = "0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2"
            elif e3 or e4:
                expected_user = "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366" if e3 else "0x8062511602a163fe84d1d2300117ea8cc1600cbd"
                expected_market = "0x45c3b59d53e2e148aaa6a857521059676d5c0489"
            elif e5 or e6:
                expected_user = "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f" if e5 else "0x079dfb0a62b4723b45166abb7892fe362543ad8d"
                expected_market = "0xe0a80d35bb6618cba260120b279d357978c42bce" if e5 else "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8"
            scoped = borrower == expected_user and raw.get("marketId") == expected_market and _address(raw.get("deployedExecutor") or raw.get("executor")) == executor
            telemetry = {"mode": None}  # Configuration is not a runner report.
            runner = _runner(telemetry, {"mode": telemetry["mode"], "checked_at": obs["utc"]}, "Base Euler V2 Runner" if b12 or b13 else "Base Morpho Runner" if b14 or b15 else "Unified Euler V2 E7" if e7 else "Unified Morpho E8" if e8 else "Unified Morpho E9" if e9 else "Unified Morpho E10" if e10 else "Base Universal Fluid Runner" if b11 else "Unified Fluid F1" if f1 else "Unified Fluid F2" if f2 else "Unified Fluid F3" if f3 else "Unified Fluid F4" if f4 else "Unified Fluid F5" if f5 else "Unified Fluid F6" if f6 else "Unified Morpho M33" if m33 else "Unified Morpho M34" if m34 else "Unified Morpho M35" if m35 else "Unified Morpho M36" if m36 else "Unified Morpho M37" if m37 else "Unified Morpho M38" if m38 else "Unified Morpho M39" if m39 else "Unified Morpho M42" if m42 else "Unified Morpho M43" if m43 else "Unified Morpho M44" if m44 else "Unified Morpho M45" if m45 else "Unified Morpho M46" if m46 else "Unified Morpho M47" if m47 else "Unified Morpho M48" if m48 else "Unified Morpho M49" if m49 else "Unified Morpho M2" if m2 else "Unified Curve/NAV YN" if yn else "Unified Euler V2" if euler_armed else "Unified Morpho M7", scoped, obs)
        elif m40 or m41:
            expected_user = "0xd7583e3cf08bbcab66f1242195227bbf9f865fda" if m40 else "0x43c0ec5456b67c8a7471b3dcadebee0e2a272e72"
            expected_market = "0x37e7484d642d90f14451f1910ba4b7b8e4c3ccdd0ec28f8b2bdb35479e472ba7" if m40 else "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e"
            scoped = (borrower == expected_user and raw.get("marketId") == expected_market
                      and _address(raw.get("deployedExecutor") or raw.get("executor")) == executor
                      and not narrow_v3 and v3.get("morphoExecution") == "M1_USDE_DAI_ARMED; PAXG_DISABLED")
            runner = _runner(v3, view["v3_live_watch"], "Unified Morpho M40" if m40 else "Unified Morpho M41", scoped, runner_observations[V3_WATCH])
        else:
            scoped = (borrower == M1_USER and raw.get("marketId") == M1_MARKET and executor == M1_EXECUTOR and v3.get("morphoExecution") == "M1_USDE_DAI_ARMED; PAXG_DISABLED") if m1 else ((executor == M1_EXECUTOR and v3.get("morphoExecution") == "M1_USDE_DAI_ARMED; PAXG_DISABLED") if m_wst else ((borrower in V3_USERS or borrower == V3_2J_USER) and venue == POOL and broad_v3 and _address(v3.get("liquidatorAddress")) == executor and executor is not None))
            scoped = scoped and not narrow_v3
            runner = _runner(v3, view["v3_live_watch"], "Unified Morpho M1" if (m1 or m_wst) else "Unified Aave V3", scoped, runner_observations[V3_WATCH])
        if base and not observation_only:
            base_match = _base_runner_match(base_watch, row, raw, venue)
            runner = _runner(base_watch, view["base_live_watch"], runner["label"], base_match is not None, base_runner_obs)
            if base_match:
                executor = base_match["executor"]
        quote = _quote({**(m32_raw if m32 else raw), "rank": row["rank"], "chainId": 42161 if arb else 8453 if base else 1}, quote_obs, kind)
        if m32 and raw.get("observationStatus") in {"INCOMPLETE", "UNAVAILABLE"}:
            obs = {**obs, "freshness": UNKNOWN, "age_text": None}
        if arb_usdg:
            quote = _arb_usdg_quote(raw, obs)
        elif arb:
            quote["notes"] = ["Runner health and position telemetry do not include a current live profit quote."]
            metadata = _ARB_METADATA.get(ident)
            if metadata and metadata[8] is not None:
                quote["estimate"] = {"gross_token_amount": _amount(metadata[8]), "gross_token_symbol": metadata[4],
                                     "gross_usd": None, "provenance": "HISTORICAL_REFERENCE",
                                     "label": "Historical simulation · not a current quote"}
        debt_symbol, collateral_symbol = ("wstETH", "USD") if f3 else ("WBTC", "USD") if f2 else ("USDT", "USD") if f1 or m33 else ("DAI", "PT-USDe-31JUL2025") if pt else ("RLUSD", "USD") if e7 else ("RLUSD", "USDe") if m10 else ("USDC", "USDC") if base or m2 else ("DAI", "USDe") if m1 else ("USD", "USD")
        if m32:
            debt_symbol, collateral_symbol = "USDtb", "USDtb"
        elif m34:
            debt_symbol, collateral_symbol = "WETH", "beraSTONE"
        elif f4 or m36 or m37 or m38 or m48 or m49 or e9:
            debt_symbol, collateral_symbol = "USDT", "USD"
        elif f5:
            debt_symbol, collateral_symbol = "WBTC", "USD"
        elif f6 or m35 or m42 or m44 or m45 or e8:
            debt_symbol, collateral_symbol = "USDC", "USD"
        elif m43:
            debt_symbol, collateral_symbol = "PYUSD", "USD"
        elif m46:
            debt_symbol, collateral_symbol = "apxUSD", "USD"
        elif m47 or e10:
            debt_symbol, collateral_symbol = "RLUSD", "USD"
        if arb_fluid:
            debt_symbol = "USDT0"
        elif arb_usdg:
            debt_symbol = "USDG"
        debt = raw.get("debtUsdc", raw.get("debtUsd")) if base else raw.get("debtUsd")
        collateral = raw.get("collateralPt") if pt else raw.get("collateralValueUsdc", raw.get("collateralUsd")) if base else raw.get("collateralUsd")
        blockers = []
        if runner.get("reason_text"):
            blockers.append(runner["reason_text"])
        if (m7 or m7b or yn or e3 or e4) and eligible and raw.get("eligibleForPreflight", raw.get("executableNow")) is False:
            blockers.append("Protocol health is underwater, but execution remains blocked by ynETHx/MCwETH withdrawal buffer capacity.")
        if obs["freshness"] != FRESH:
            blockers.append("Health observation is stale, incomplete or unavailable.")
        if not observation_only and not known:
            blockers.append("Explicit protocol eligibility and valid health evidence are required.")
        if observation_only:
            blockers.append(row["readiness_note"])
        else:
            blockers.append("Protocol eligibility is not executable profitability; costs and execution readiness remain unproven here.")
            if not quote["available"] or quote["freshness"] != FRESH:
                blockers.append("No complete fresh runner quote is available." if arb else "No complete fresh sentinel quote is available.")
        row.update(borrower_address=borrower, venue_address=venue, executor_address=executor, market_id=_address(raw.get("marketId")) if yn or euler or f1 or f2 or f3 or f4 or f5 or f6 or b11 or arb_fluid else _hash(raw.get("marketId")),
            chain_name="Arbitrum" if arb else "Base" if base else "Ethereum", status={"code": code, "label": label, "tone": tone}, observation=obs, quote=quote,
            position={"debt_amount": None if paxg else _amount(debt), "debt_symbol": None if paxg else debt_symbol,
                      "collateral_amount": None if paxg else _amount(collateral), "collateral_symbol": None if paxg else collateral_symbol,
                      "borrow_apr_pct": _amount(raw.get("borrowAprPct")), "passive_hours": _amount(raw.get("passiveHoursToCrossing")),
                       "heartbeat_hours": _amount(raw.get("hoursUntil24hHeartbeat")), "is_estimate": bool(raw.get("healthIsEstimate", True)) if base or pt else False},
            runner=runner, sentinel_observation=quote_obs if any(k in raw for k in ("observationBlock", "observationHash", "observationUtc")) else None,
            blockers=blockers, bps_numeric=bps, gross_usd_numeric=_number(quote["gross_usd"], signed=True),
            liquidatable_now=None if paxg or not known or obs["freshness"] != FRESH else eligible,
            health_is_estimate=bool(raw.get("healthIsEstimate", True)) if base else row["health_is_estimate"],
            health_factor=f"{health:.6f}" if health is not None else None, bps_to_liq=f"{bps:.4f}" if bps is not None else None,
            observation_block=obs["block"], observation_utc=obs["utc"], executor=ops._short_address(executor),
            surplus_usd=(f"{quote['gross_token_amount']} {quote['gross_token_symbol']} (gross, pre-gas)" if quote["gross_token_amount"] is not None else None))
        if closed:
            row.update(inactive=code == "INACTIVE", position_status="CLOSED", armed=False, executable_now=False,
                       liquidatable_now=False if code == "INACTIVE" else None, calldata_ready=False,
                       readiness_note=CLOSED_POSITION_NOTE, blockers=[CLOSED_POSITION_NOTE] + ([] if code == "INACTIVE" else ["Stored debt observation is aged; current position status is unknown."]),
                       quote=_quote({}, obs, kind), surplus_usd=None, repay_summary=None, seized_summary=None, gross_usd_numeric=None)
            row["runner"] = {**runner, "reported_armed": False}
        if arb_usdg and quote.get("is_simulated"):
            tranche = ", per 250k tranche" if raw["rank"] == "#ARB9" else ""
            row["surplus_usd"] = None
        if m1:
            row["heartbeat_hours_left"] = f"{row['position']['collateral_amount']} USDe coll" if row["position"]["collateral_amount"] is not None else None
            row["passive_hours_left"] = f"{row['position']['debt_amount']} DAI debt" if row["position"]["debt_amount"] is not None else None
            if row["passive_hours_left"] is not None and row["position"]["passive_hours"] is not None:
                row["passive_hours_left"] += f" ({row['position']['passive_hours']}h passive estimate)"
        _execution_evidence(row)
        rows.append(row)
    return _current_2k_2l_overlay(_m32_historical_overlay(_rank1_v2_overlay({"schema": "dashboard-targets/v1", "generated_at": ops._iso(now), "available": view["available"],
            "freshness": sentinel_obs["freshness"], "age_text": sentinel_obs["age_text"], "pin_block": sentinel_obs["block"], "pin_utc": sentinel_obs["utc"],
            "warnings": [ops.scrub_text(w) for w in view["warnings"]] + ["Gross quotes are conditional, before costs and never realized profit.", "Passive countdowns are estimates assuming unchanged rates and prices; no exact source/runtime equivalence is asserted."],
            "summary": {"total": len(rows), "eligible": sum(r["status"]["code"] == "ELIGIBLE" for r in rows),
                        "observation_only": sum(r["observation_only"] for r in rows), "stale": sum(r["observation"]["freshness"] in {AGING, STALE} for r in rows)},
            "targets": rows, "runners": {"v3": view["v3_live_watch"], "v4": view["v4_live_watch"], "base": view["base_live_watch"]},
            "deployments": {"unified": view["deploy"], "v4": view["v4_executor"]},
              "evidence": {"v4": view["v4_rehearsal"], "base": view["base_rehearsal"]}}, reader, now), reader), reader, now)


def build_targets(reader: Any, now: float, query: Any = None, *, process_snapshot: Any = None) -> dict[str, Any]:
    from .target_sources import aggregate_targets

    view = _m32_historical_overlay(_rank1_v2_overlay(aggregate_targets(reader, now, query, trade_candidates=True), reader, now), reader)
    view = _current_2k_2l_overlay(view, reader, now)
    for row in view["targets"]:
        _execution_evidence(row, now, process_snapshot)
    return view


def build_inventory(reader: Any, now: float, query: Any = None) -> dict[str, Any]:
    from .target_sources import aggregate_targets

    result = aggregate_targets(reader, now, query, trade_candidates=False)
    result["view_mode"] = "historical_inventory"
    result = _m32_historical_overlay(_rank1_v2_overlay(result, reader, now), reader)
    result = _current_2k_2l_overlay(result, reader, now)
    for row in result["targets"]:
        _execution_evidence(row)
    return result
