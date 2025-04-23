document.addEventListener('DOMContentLoaded', () => {

    const cardContainer = document.getElementById('card-container');
    const sortDropdown = document.getElementById('sort-dropdown');
    const searchButton = document.getElementById('search-button');
    const searchInput = document.getElementById('search-input');
    const creatureFilter = document.getElementById('creature-filter');
    const myListButton = document.getElementById('my-list-button');
    const customListModal = document.getElementById('custom-list-modal');
    const closeModalButton = document.querySelector('.close-button');
    const requestCardButton = document.getElementById('request-card-button');

    let allCardsData = [];

    // === AUTO LOAD CARDS ON PAGE LOAD ===
    fetchAndDisplayJSON();
    loadCreatureTypes();

    // === SORT DROPDOWN ===
    sortDropdown.addEventListener('change', (e) => {
        const sortOption = e.target.value;
        sortCards(sortOption);
    });

    // === SEARCH BUTTON CLICK ===
    searchButton.addEventListener('click', () => {
        triggerSearch();
    });

    // === SEARCH INPUT ENTER KEY ===
    searchInput.addEventListener('keyup', (event) => {
        if (event.key === 'Enter') {
            triggerSearch();
        }
    });

    // === SEARCH BAR LETTER LISTENER ===
    searchInput.addEventListener('input', () => {
        const inputValue = searchInput.value.trim().toLowerCase();

        if (inputValue.length === 1) {
            searchForCardsStartingWithLetter(inputValue);
        } else if (inputValue.length === 0) {
            renderAllCards();
        }
    });

    // === CREATURE TYPE FILTER ===
    creatureFilter.addEventListener('change', () => {
        const selectedType = creatureFilter.value.toLowerCase();

        const filtered = selectedType
            ? allCardsData.filter(card =>
                Array.isArray(card.creatureTypes) &&
                card.creatureTypes.some(type => type.toLowerCase() === selectedType))
            : allCardsData;

        cardContainer.innerHTML = '';
        filtered.forEach(card => displayCard(card));
    });

    // === TRIGGER SEARCH FUNCTION ===
    function triggerSearch() {
        const searchTerm = searchInput.value.trim();
        if (!searchTerm) {
            alert("Please enter a card name to search.");
            return;
        }
        searchForCard(searchTerm);
    }

    // === FETCH JSON AND DISPLAY ===
    function fetchAndDisplayJSON() {
        fetch('Cards/cards.json')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to fetch JSON');
                }
                return response.json();
            })
            .then(jsonData => {
                allCardsData = jsonData;
                renderAllCards();
            })
            .catch(error => console.error('Error fetching JSON:', error));
    }

    // === LOAD CREATURE TYPES FROM BACKEND ===
    function loadCreatureTypes() {
        fetch('https://geega-games-website-production.up.railway.app/api/inventory/creature-types')
            .then(res => res.json())
            .then(types => {
                types.forEach(type => {
                    const option = document.createElement('option');
                    option.value = type;
                    option.textContent = type;
                    creatureFilter.appendChild(option);
                });
            })
            .catch(err => console.error('❌ Failed to load creature types:', err));
    }

    // === DISPLAY CARD ===
    function displayCard(cardData) {
        const cardDiv = document.createElement('div');
        cardDiv.className = 'card';

        const img = document.createElement('img');
        img.src = cardData.image || 'https://via.placeholder.com/250x350?text=No+Image';

        const nameText = document.createElement('h3');
        nameText.textContent = cardData.Name;

        const quantityText = document.createElement('p');
        quantityText.textContent = `Quantity: ${cardData.Quantity}`;

        const setText = document.createElement('p');
        setText.textContent = `Set: ${cardData.Set}`;

        const typeText = document.createElement('p');
        typeText.textContent = `Type: ${cardData.Type}`;

        cardDiv.appendChild(nameText);
        cardDiv.appendChild(img);
        cardDiv.appendChild(quantityText);
        cardDiv.appendChild(setText);
        cardDiv.appendChild(typeText);

        cardContainer.appendChild(cardDiv);
    }

    // === SORT CARDS FUNCTION ===
    function sortCards(option) {
        if (allCardsData.length === 0) return;

        if (option === "asc") {
            allCardsData.sort((a, b) => a.Name.localeCompare(b.Name));
        }

        if (option === "desc") {
            allCardsData.sort((a, b) => b.Name.localeCompare(a.Name));
        }

        renderAllCards();
    }

    // === SEARCH FUNCTION WITH EXACT LETTER ORDER ===
    function searchForCard(searchTerm) {
        const sanitizedSearchTerm = sanitizeText(searchTerm);

        const results = allCardsData.filter(card => {
            const sanitizedCardName = sanitizeText(card.Name);
            return sanitizedCardName.startsWith(sanitizedSearchTerm);
        });

        if (results.length === 0) {
            cardContainer.innerHTML = `<p>No cards found starting with "${searchTerm}".</p>`;
        } else {
            cardContainer.innerHTML = '';
            results.forEach(card => displayCard(card));
        }
    }

    // === SEARCH FOR CARDS STARTING WITH A LETTER ===
    function searchForCardsStartingWithLetter(letter) {
        const results = allCardsData.filter(card => {
            const sanitizedCardName = sanitizeText(card.Name);
            return sanitizedCardName.startsWith(letter);
        });

        if (results.length === 0) {
            cardContainer.innerHTML = `<p>No cards found starting with "${letter.toUpperCase()}".</p>`;
        } else {
            cardContainer.innerHTML = '';
            results.forEach(card => displayCard(card));
        }
    }

    // === SANITIZE TEXT (REMOVE PUNCTUATION AND LOWERCASE) ===
    function sanitizeText(text) {
        return text.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").toLowerCase();
    }

    // === RENDER ALL CARDS ===
    function renderAllCards() {
        cardContainer.innerHTML = '';
        allCardsData.forEach(card => displayCard(card));
    }

    // === CUSTOM LIST MODAL OPEN ===
    if (myListButton) {
        myListButton.addEventListener('click', () => {
            customListModal.style.display = 'block';
        });
    }

    // === CUSTOM LIST MODAL CLOSE ===
    if (closeModalButton) {
        closeModalButton.addEventListener('click', () => {
            customListModal.style.display = 'none';
        });
    }

    // === CLOSE MODAL IF CLICKING OUTSIDE ===
    window.addEventListener('click', (event) => {
        if (event.target === customListModal) {
            customListModal.style.display = 'none';
        }
    });

    // === REQUEST BUTTON REDIRECT ===
    if (requestCardButton) {
        requestCardButton.addEventListener('click', () => {
            window.location.href = 'request.html';
        });
    }

});
