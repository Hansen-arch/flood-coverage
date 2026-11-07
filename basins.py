"""Four basins chosen to contrast hydrological response time and observation scenario.

Po       - large lowland river, slow response (days), well instrumented, in CEMS/EFAS.
Ahr      - small steep catchment, flash response (hours), site of the 2021 disaster.
Siak     - peatland river in Riau, slow response (weeks), outside the European scenario.
Ciliwung - urban river through Jakarta, flash response (hours), same situation.

The first two sit in the Sentinel-1 European observation scenario and the second two
do not, which is exactly the comparison the demo exists to make: identical method,
identical window, identical collection, different mission plan.
"""

BASINS = [
    {
        "id": "po",
        "short": "Po",
        "name": "Po River, lower plain",
        "country": "IT",
        "bbox": [11.20, 44.75, 12.20, 45.15],
        "response": "slow",
        # Publicly stated response time for a large lowland river flood.
        "rise_hours": 48,
        "rise_source": "large lowland river, days-scale rise",
    },
    {
        "id": "ahr",
        "short": "Ahr",
        "name": "Ahr valley",
        "country": "DE",
        "bbox": [6.90, 50.30, 7.40, 50.70],
        "response": "flash",
        "rise_hours": 6,
        "rise_source": "steep small catchment, hours-scale rise",
    },
    {
        "id": "siak",
        "short": "Siak",
        "name": "Siak, Riau",
        "country": "ID",
        "bbox": [101.00, 0.20, 102.40, 1.30],
        "response": "slow",
        # Peatland rivers rise over days to weeks. A week is the conservative end.
        "rise_hours": 168,
        "rise_source": "peatland river, weeks-scale rise, conservative",
    },
    {
        "id": "ciliwung",
        "short": "Jakarta",
        "name": "Ciliwung, Jakarta",
        "country": "ID",
        "bbox": [106.70, -6.50, 107.00, -6.15],
        "response": "flash",
        "rise_hours": 6,
        "rise_source": "urban river, convective storm response, hours",
    },
]

BASIN_BY_ID = {b["id"]: b for b in BASINS}
