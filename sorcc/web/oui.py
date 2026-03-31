"""SORCC-PI — OUI manufacturer lookup and BT device classification.

Maps the first 3 bytes of a MAC address (OUI prefix) to manufacturer and
device category. Falls back to name-based heuristics and BLE random
address detection.
"""

from __future__ import annotations

# OUI prefix → (manufacturer, category)
# Categories: phone, wearable, laptop, tablet, speaker, beacon, vehicle, iot, network, other
OUI_TABLE: dict[str, tuple[str, str]] = {
    # Apple
    "00:17:C9": ("Apple", "phone"), "04:15:52": ("Apple", "phone"),
    "04:E5:36": ("Apple", "phone"), "08:66:98": ("Apple", "phone"),
    "0C:51:01": ("Apple", "phone"), "10:94:BB": ("Apple", "phone"),
    "14:7D:DA": ("Apple", "phone"), "18:3E:EF": ("Apple", "phone"),
    "1C:36:BB": ("Apple", "phone"), "20:78:F0": ("Apple", "phone"),
    "24:A2:E1": ("Apple", "phone"), "28:6A:BA": ("Apple", "phone"),
    "2C:BE:EB": ("Apple", "phone"), "3C:06:30": ("Apple", "phone"),
    "40:B3:95": ("Apple", "phone"), "44:2A:60": ("Apple", "phone"),
    "48:A9:1C": ("Apple", "phone"), "4C:57:CA": ("Apple", "phone"),
    "54:4E:90": ("Apple", "phone"), "58:B0:35": ("Apple", "phone"),
    "5C:97:F3": ("Apple", "phone"), "60:83:E7": ("Apple", "phone"),
    "64:B0:A6": ("Apple", "phone"), "68:DB:F5": ("Apple", "phone"),
    "6C:94:66": ("Apple", "phone"), "70:3E:AC": ("Apple", "phone"),
    "78:7E:61": ("Apple", "phone"), "7C:D1:C3": ("Apple", "phone"),
    "80:BE:05": ("Apple", "phone"), "84:FC:FE": ("Apple", "phone"),
    "88:66:A5": ("Apple", "phone"), "8C:85:90": ("Apple", "phone"),
    "90:8D:6C": ("Apple", "phone"), "94:E9:79": ("Apple", "phone"),
    "98:01:A7": ("Apple", "phone"), "9C:20:7B": ("Apple", "phone"),
    "A0:99:9B": ("Apple", "phone"), "A4:83:E7": ("Apple", "phone"),
    "A8:5C:2C": ("Apple", "phone"), "AC:BC:32": ("Apple", "phone"),
    "B0:19:C6": ("Apple", "phone"), "B8:53:AC": ("Apple", "phone"),
    "BC:52:B7": ("Apple", "phone"), "C0:A5:3E": ("Apple", "phone"),
    "C8:69:CD": ("Apple", "phone"), "CC:08:8D": ("Apple", "phone"),
    "D0:81:7A": ("Apple", "phone"), "D4:61:9D": ("Apple", "phone"),
    "D8:1C:79": ("Apple", "phone"), "DC:A4:CA": ("Apple", "phone"),
    "E0:5F:45": ("Apple", "phone"), "E4:C6:3D": ("Apple", "phone"),
    "F0:18:98": ("Apple", "phone"), "F4:5C:89": ("Apple", "phone"),
    "F8:4D:89": ("Apple", "phone"),
    # Samsung
    "00:07:AB": ("Samsung", "phone"), "00:12:FB": ("Samsung", "phone"),
    "00:1A:8A": ("Samsung", "phone"), "00:21:19": ("Samsung", "phone"),
    "00:26:37": ("Samsung", "phone"), "08:D4:6A": ("Samsung", "phone"),
    "10:D5:42": ("Samsung", "phone"), "14:49:E0": ("Samsung", "phone"),
    "18:3A:2D": ("Samsung", "phone"), "1C:AF:05": ("Samsung", "phone"),
    "24:18:1D": ("Samsung", "phone"), "28:CC:01": ("Samsung", "phone"),
    "30:07:4D": ("Samsung", "phone"), "34:23:BA": ("Samsung", "phone"),
    "38:01:95": ("Samsung", "phone"), "40:4E:36": ("Samsung", "phone"),
    "44:78:3E": ("Samsung", "phone"), "4C:3C:16": ("Samsung", "phone"),
    "50:01:BB": ("Samsung", "phone"), "54:40:AD": ("Samsung", "phone"),
    "58:C3:8B": ("Samsung", "phone"), "64:77:91": ("Samsung", "phone"),
    "6C:F3:73": ("Samsung", "phone"), "78:47:1D": ("Samsung", "phone"),
    "84:25:DB": ("Samsung", "phone"), "8C:F5:A3": ("Samsung", "phone"),
    "94:01:C2": ("Samsung", "phone"), "98:52:B1": ("Samsung", "phone"),
    "A0:82:1F": ("Samsung", "phone"), "A8:7C:01": ("Samsung", "phone"),
    "B4:79:C8": ("Samsung", "phone"), "BC:14:EF": ("Samsung", "phone"),
    "C4:50:06": ("Samsung", "phone"), "CC:07:AB": ("Samsung", "phone"),
    "D0:22:BE": ("Samsung", "phone"), "E4:7D:BD": ("Samsung", "phone"),
    "F0:25:B7": ("Samsung", "phone"), "FC:A1:83": ("Samsung", "phone"),
    # Google
    "08:9E:08": ("Google", "phone"), "30:FD:38": ("Google", "speaker"),
    "48:D6:D5": ("Google", "speaker"), "54:60:09": ("Google", "speaker"),
    "A4:77:33": ("Google", "phone"), "F4:F5:D8": ("Google", "speaker"),
    "F4:F5:E8": ("Google", "speaker"),
    # Wearables
    "B0:B2:8F": ("Fitbit", "wearable"), "C8:FF:77": ("Fitbit", "wearable"),
    "E6:D5:7A": ("Fitbit", "wearable"),
    "D4:22:CD": ("Garmin", "wearable"), "C8:3E:99": ("Garmin", "wearable"),
    "EC:85:2F": ("Garmin", "wearable"),
    # Amazon
    "10:2C:6B": ("Amazon", "speaker"), "34:D2:70": ("Amazon", "speaker"),
    "44:00:49": ("Amazon", "speaker"), "50:DC:E7": ("Amazon", "speaker"),
    "68:37:E9": ("Amazon", "speaker"), "74:C2:46": ("Amazon", "speaker"),
    "A0:02:DC": ("Amazon", "speaker"), "FC:65:DE": ("Amazon", "speaker"),
    # Microsoft
    "28:18:78": ("Microsoft", "laptop"), "7C:1E:52": ("Microsoft", "laptop"),
    "C8:3D:D4": ("Microsoft", "laptop"),
    # Intel (laptops/PCs)
    "00:1E:64": ("Intel", "laptop"), "3C:A9:F4": ("Intel", "laptop"),
    "60:57:18": ("Intel", "laptop"), "80:86:F2": ("Intel", "laptop"),
    "A4:C4:94": ("Intel", "laptop"), "DC:1B:A1": ("Intel", "laptop"),
    # Networking / Routers
    "00:1A:2B": ("Cisco", "network"), "00:50:56": ("VMware", "network"),
    "28:AF:42": ("ARRIS", "network"), "20:10:7A": ("ARRIS", "network"),
    "E8:65:D4": ("Netgear", "network"), "C4:04:15": ("Netgear", "network"),
    "10:0C:6B": ("Netgear", "network"), "A4:2B:B0": ("TP-Link", "network"),
    "50:C7:BF": ("TP-Link", "network"), "C0:25:E9": ("TP-Link", "network"),
    "B0:4E:26": ("TP-Link", "network"), "C8:A6:EF": ("ZTE", "phone"),
    "00:04:3E": ("Telit", "iot"),
    "B8:27:EB": ("Raspberry Pi", "iot"), "DC:A6:32": ("Raspberry Pi", "iot"),
    "D8:3A:DD": ("Raspberry Pi", "iot"), "2C:CF:67": ("Raspberry Pi", "iot"),
    # Vehicles / Automotive
    "04:52:C7": ("Tesla", "vehicle"), "4C:FC:AA": ("Tesla", "vehicle"),
    # Beacons / Trackers
    "E8:59:0C": ("Tile", "beacon"), "F0:13:C3": ("Chipolo", "beacon"),
    # Meta / Reality Labs
    "2C:26:17": ("Meta", "wearable"),
    # LG
    "00:1C:62": ("LG", "phone"), "10:68:3F": ("LG", "phone"),
    "30:76:6F": ("LG", "phone"), "64:89:9A": ("LG", "phone"),
    "88:C9:D0": ("LG", "phone"), "BC:F5:AC": ("LG", "phone"),
    # Xiaomi
    "04:CF:8C": ("Xiaomi", "phone"), "28:6C:07": ("Xiaomi", "phone"),
    "34:CE:00": ("Xiaomi", "phone"), "50:64:2B": ("Xiaomi", "iot"),
    "64:CC:2E": ("Xiaomi", "phone"), "78:11:DC": ("Xiaomi", "phone"),
    # Huawei / Honor
    "00:46:4B": ("Huawei", "phone"), "04:B0:E7": ("Huawei", "phone"),
    "20:A6:80": ("Huawei", "phone"), "48:DB:50": ("Huawei", "phone"),
    "70:8C:B6": ("Huawei", "phone"), "CC:A2:23": ("Huawei", "phone"),
    # Sony
    "00:1D:BA": ("Sony", "phone"), "04:5D:4B": ("Sony", "phone"),
    "AC:9B:0A": ("Sony", "phone"),
    # OnePlus
    "94:65:2D": ("OnePlus", "phone"), "C0:EE:FB": ("OnePlus", "phone"),
    # Motorola / Lenovo
    "00:04:0E": ("Motorola", "phone"), "9C:D3:5B": ("Motorola", "phone"),
    "C8:14:51": ("Motorola", "phone"),
    # Bose
    "28:11:A5": ("Bose", "speaker"), "4C:87:5D": ("Bose", "speaker"),
    # JBL / Harman
    "00:02:5B": ("JBL", "speaker"), "30:C0:1B": ("JBL", "speaker"),
}

CATEGORY_ICONS: dict[str, str] = {
    "phone": "\U0001f4f1", "wearable": "\u231a", "laptop": "\U0001f4bb",
    "tablet": "\U0001f4f1", "speaker": "\U0001f50a", "beacon": "\U0001f4cd",
    "vehicle": "\U0001f697", "iot": "\U0001f4e1", "network": "\U0001f5a7",
    "other": "\U0001f4e1",
}

# Name-based classification heuristics
_NAME_PATTERNS: list[tuple[str, tuple[str, str]]] = [
    # Apple
    ("iphone", ("Apple", "phone")), ("ipad", ("Apple", "tablet")),
    ("macbook", ("Apple", "laptop")), ("apple watch", ("Apple", "wearable")),
    ("airpods", ("Apple", "wearable")),
    # Android phones
    ("galaxy", ("Samsung", "phone")), ("pixel", ("Google", "phone")),
    ("oneplus", ("OnePlus", "phone")), ("redmi", ("Xiaomi", "phone")),
    ("poco", ("Xiaomi", "phone")), ("moto ", ("Motorola", "phone")),
    # Wearables & headphones
    ("fitbit", ("Fitbit", "wearable")), ("garmin", ("Garmin", "wearable")),
    ("fenix", ("Garmin", "wearable")), ("forerunner", ("Garmin", "wearable")),
    ("venu", ("Garmin", "wearable")), ("instinct", ("Garmin", "wearable")),
    ("shokz", ("Shokz", "wearable")), ("openfit", ("Shokz", "wearable")),
    ("openrun", ("Shokz", "wearable")),
    ("nothing ear", ("Nothing", "wearable")), ("nothing phone", ("Nothing", "phone")),
    ("buds", ("Samsung", "wearable")), ("band ", ("Xiaomi", "wearable")),
    ("mi band", ("Xiaomi", "wearable")),
    # Smart speakers
    ("echo", ("Amazon", "speaker")), ("alexa", ("Amazon", "speaker")),
    ("google home", ("Google", "speaker")), ("nest", ("Google", "speaker")),
    ("homepod", ("Apple", "speaker")),
    # Audio
    ("bose", ("Bose", "speaker")), ("jbl", ("JBL", "speaker")),
    ("sonos", ("Sonos", "speaker")), ("harman", ("Harman", "speaker")),
    ("beats", ("Apple", "wearable")), ("sony wh-", ("Sony", "wearable")),
    ("sony wf-", ("Sony", "wearable")),
    # Laptops / PCs
    ("surface", ("Microsoft", "laptop")), ("laptop-", ("Windows PC", "laptop")),
    ("desktop-", ("Windows PC", "laptop")),
    # Gaming / VR
    ("xbox", ("Microsoft", "other")), ("meta quest", ("Meta", "wearable")),
    ("playstation", ("Sony", "other")), ("switch", ("Nintendo", "other")),
    # Vehicles
    ("tesla", ("Tesla", "vehicle")),
    # IoT / Smart Home / Appliances
    ("ring ", ("Amazon", "iot")), ("wyze", ("Wyze", "iot")),
    ("tuya", ("Tuya", "iot")), ("smartthings", ("Samsung", "iot")),
    ("hue", ("Philips", "iot")), ("controller", ("IoT", "iot")),
    # Printers
    ("et-", ("Epson", "iot")), ("epson", ("Epson", "iot")),
    ("hp ", ("HP", "iot")), ("canon", ("Canon", "iot")),
    ("brother", ("Brother", "iot")),
    # Trackers
    ("tile", ("Tile", "beacon")), ("airtag", ("Apple", "beacon")),
    ("chipolo", ("Chipolo", "beacon")),
    # Samsung display/appliance patterns (e.g. "S19" = TV series)
    ("[tv]", ("Samsung", "iot")), ("[monitor]", ("Samsung", "iot")),
]


def classify_device(mac: str, name: str = "", dev_type: str = "") -> dict[str, str]:
    """Identify manufacturer and category from MAC OUI or device name patterns."""
    oui = mac[:8].upper() if mac else ""
    result: dict[str, str] = {"manufacturer": "", "category": "other", "icon": CATEGORY_ICONS["other"]}

    # OUI lookup
    if oui in OUI_TABLE:
        mfr, cat = OUI_TABLE[oui]
        result["manufacturer"] = mfr
        result["category"] = cat
        result["icon"] = CATEGORY_ICONS.get(cat, CATEGORY_ICONS["other"])
        return result

    # Name-based heuristics
    name_lower = (name or "").lower()
    for keyword, (mfr, cat) in _NAME_PATTERNS:
        if keyword in name_lower:
            result["manufacturer"] = mfr
            result["category"] = cat
            result["icon"] = CATEGORY_ICONS.get(cat, CATEGORY_ICONS["other"])
            return result

    # BLE random address detection (bit 1 of first byte = 1 means locally administered)
    if mac and len(mac) >= 2:
        try:
            first_byte = int(mac[:2], 16)
            if first_byte & 0x02:
                result["manufacturer"] = "Random BLE"
                result["category"] = "phone"
                result["icon"] = CATEGORY_ICONS["phone"]
                return result
        except ValueError:
            pass

    # BLE device with no friendly name (name == MAC) — likely anonymous advertiser
    if dev_type in ("BTLE", "BR/EDR") and name and name == mac:
        result["manufacturer"] = "BLE Device"
        result["category"] = "phone"
        result["icon"] = CATEGORY_ICONS["phone"]

    return result
