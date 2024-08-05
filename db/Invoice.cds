namespace hotel.invoice;

entity extractedDetails {
    key invoiceno    : String(60);
        invoicedate  : Date;
        grossAmount  : Integer;
        netAmount    : Integer;
        buyerAddress : String;
        receiverCity : String;
        buyerContact : String;
        taxAmount    : Integer;
}
