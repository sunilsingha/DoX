const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

async function uploadImageAndExtractData(token, imagePath) {
    const doxUrl = 'https://aiservices-trial-dox.cfapps.us10.hana.ondemand.com/document-information-extraction/v1/document/jobs';

    // Check if the file exists
    if (!fs.existsSync(imagePath)) {
        throw new Error(`File not found: ${imagePath}`);
    }

    // Read the image file
    let imageFile;
    try {
        imageFile = fs.readFileSync(imagePath);
        console.log(`Successfully read file: ${imagePath}`);
    } catch (error) {
        throw new Error(`Failed to read file: ${imagePath}`);
    }

    // Construct the FormData object
    const formData = new FormData();
    formData.append('file', imageFile, path.basename(imagePath));
    formData.append('options', JSON.stringify({
        "clientId": "default",
        "extraction": {
            "headerFields": [
                "documentNumber",
                "purchaseOrderNumber",
                "documentDate",
                "dueDate",
                "grossAmount",
                "currencyCode"
            ],
            "lineItemFields": [
                "description",
                "quantity",
                "unitOfMeasure",
                "unitPrice",
                "netAmount"
            ]
        },
        "documentType": "invoice"
    }));

    const headers = {
        'Authorization': `Bearer ${token}`,
        ...formData.getHeaders()
    };

    try {
        // Upload the image
        const uploadResponse = await axios.post(doxUrl, formData, { headers });

        if (uploadResponse.status !== 201) {
            throw new Error(`Failed to upload image: ${uploadResponse.status}`);
        }

        const jobId = uploadResponse.data.id;
        console.log(`Job ID: ${jobId}`);

        // Poll for the extraction result
        const resultUrl = `${doxUrl}/${jobId}`;
        console.log(`Result URL: ${resultUrl}`);

        let extractionResult;
        let retries = 0;
        const maxRetries = 20; // Adjust as needed
        const retryInterval = 5000; // 5 seconds

        while (retries < maxRetries) {
            const resultResponse = await axios.get(resultUrl, { headers });

            if (resultResponse.status !== 200) {
                throw new Error(`Failed to get extraction result: ${resultResponse.status}`);
            }

            extractionResult = resultResponse.data;

            if (extractionResult.status === 'DONE') {
                break;
            } else if (extractionResult.status === 'FAILED') {
                throw new Error('Document extraction failed');
            }

            retries++;
            console.log(`Retry ${retries}/${maxRetries} - Status: ${extractionResult.status}`);

            // Wait for a few seconds before polling again
            await new Promise(resolve => setTimeout(resolve, retryInterval));
        }

        if (retries === maxRetries) {
            throw new Error('Exceeded maximum retries. Document extraction still pending.');
        }

        return extractionResult;

    } catch (error) {
        if (error.response) {
            console.error('Error response data:', error.response.data);
        }
        console.error('Error during document extraction:', error);
        throw error;
    }
}

module.exports = { uploadImageAndExtractData };
