namespace hr.lms;


entity Students {
    key email        : String(65);
        first_name   : String(30);
        last_name    : String(30);
        date_sign_up : Date;
}

annotate Students with @(UI : {
    SelectionFields : [

    ],

    LineItem        : [
        {
            Label : 'Email',
            Value : email,
        },
        {
            Label : 'First Name',
            Value : first_name,
        },
        {
            Label : 'Last Name',
            Value : last_name,
        },
        {
            Label : 'Date of Sign up',
            Value : date_sign_up,
        }
    ],
    HeaderInfo      : {Description : {Value : email, }},
});
