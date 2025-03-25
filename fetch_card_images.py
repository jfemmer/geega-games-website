import json
import requests
import time

# Load the original JSON data
with open('cards.json', 'r', encoding='utf-8') as file:
    cards = json.load(file)

# Function to fetch image URL from Scryfall
def get_card_image_url(name, set_code, collector_number=None):
    # Clean and prepare fields
    cleaned_name = name.split("(")[0].strip()  # Remove anything like (List), (Borderless), etc.
    lowered_name = name.lower()
    set_code = set_code.strip().lower()

    # Detect "The List" cards
    if 'list' in lowered_name or set_code == 'plist':
        set_code = 'plist'

    # Build the base query
    query = f'{cleaned_name} set:{set_code}'

    # Add special treatments
    if 'borderless' in lowered_name:
        query += ' is:borderless'
    elif 'showcase' in lowered_name:
        query += ' frame:showcase'
    elif 'extended' in lowered_name or 'extended art' in lowered_name:
        query += ' frame:extendedart'

    # Detect Secret Lair Rainbow Foil cards
    if 'rainbow foil' in lowered_name or set_code.startswith('sl'):
        query += ' finish:rainbow_foil'

    # If you have a collector number, use the exact lookup (best match!)
    if collector_number:
        search_url = f"https://api.scryfall.com/cards/{set_code}/{collector_number}"
        print(f"👉 Using collector number query: {search_url}")
    else:
        # Fallback to search query
        search_url = f"https://api.scryfall.com/cards/search?q={requests.utils.quote(query)}"
        print(f"🔎 Search query: {search_url}")

    try:
        response = requests.get(search_url)
        if response.status_code == 200:
            if collector_number:
                # Direct lookup returns a single card
                card_data = response.json()
            else:
                # Search returns a list of cards
                data = response.json()
                if not data['data']:
                    print(f"❌ No results found for {name} ({set_code})")
                    return None
                card_data = data['data'][0]  # First result

            # Extract the image URL
            if 'image_uris' in card_data:
                return card_data['image_uris'].get('normal', None)
            elif 'card_faces' in card_data:
                # Double-faced or modal cards
                return card_data['card_faces'][0]['image_uris'].get('normal', None)
            else:
                print(f"⚠️ No image_uris found for {name} ({set_code})")

        else:
            print(f"❌ Failed to fetch {name} ({set_code}): HTTP {response.status_code}")

    except Exception as e:
        print(f"❗ Error fetching {name} ({set_code}): {e}")

    return None

# Iterate through cards and add image URLs
for card in cards:
    name = card['Name']
    set_code = card['Set'].strip()

    # Optional: Provide collector number if it's available
    collector_number = card.get('CollectorNumber', None)

    print(f"\n🔍 Fetching: {name} ({set_code})")

    image_url = get_card_image_url(name, set_code, collector_number)
    card['ImageURL'] = image_url

    time.sleep(0.1)  # Throttle requests

# Save the updated JSON with image URLs
with open('cards_with_images.json', 'w', encoding='utf-8') as outfile:
    json.dump(cards, outfile, indent=4, ensure_ascii=False)

print("✅ Done! Images have been added to 'cards_with_images.json'.")