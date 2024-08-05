const axios = require('axios');
const { uploadImageAndExtractData } = require('./doxService');
const path = require('path');
const cds = require('@sap/cds');

const getMeToken = async function(srv) {
    srv.on("token", async function(req) {
        try {
            const token = await getOToken();
            return { token };
        } catch (error) {
            req.error(500, 'Failed to get OAuth token');
        }
    });
}

const extractData = async function(srv) {
    srv.on('extractDataFromImage', async function(req) {
        const token = await getOToken();
        const imagePath = path.join(__dirname, '../images/hotel.jpeg');
        const extractionResult = await uploadImageAndExtractData(token, imagePath);
        req.reply(extractionResult);
    });
};

async function getOToken() {
    const clientId = 'sb-2c09b204-d523-41dd-b1a6-88015cfe5d76!b305505|dox-xsuaa-std-trial!b10844';
    const clientSecret = '9ded3279-bc9c-4b50-874e-7189800488cd$fmXtMFuEuvGdETQNAeJW33XOgcReia0gIc2bT74I5ng=';
    const tokenUrl = 'https://b7b9395btrial.authentication.us10.hana.ondemand.com/oauth/token';
    const grantType = 'client_credentials';

    const payload = new URLSearchParams({
        'client_id': clientId,
        'client_secret': clientSecret,
        'grant_type': grantType
    });

    const response = await axios.post(tokenUrl, payload);
    if (response.status === 200) {
        return response.data.access_token;
    } else {
        throw new Error(`Failed to get token: ${response.status}`);
    }
}

module.exports = cds.service.impl(async function() {
    // Register the functions with the service
    await getMeToken(this);
    await extractData(this);
});
